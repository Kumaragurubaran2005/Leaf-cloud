import express from "express";
import multer from "multer";
import oracledb from "oracledb";
import cors from "cors";
import jwt from "jsonwebtoken";
import archiver from "archiver";

const app = express();
app.use(express.json());
app.use(cors());

// -------------------- FILE STORAGE --------------------
const storage = multer.memoryStorage();
// Create custom multer instance to handle dynamic fields
const upload = multer({ 
  storage,
  fileFilter: (req, file, cb) => {
    // Allow any field name that starts with "output_"
    if (file.fieldname.startsWith('output_')) {
      cb(null, true);
    } else if (['result', 'usage', 'dataset', 'code', 'requirement'].includes(file.fieldname)) {
      cb(null, true);
    } else {
      cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    }
  }
});

// -------------------- ENV / CONFIG --------------------
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";
const JWT_EXPIRES_IN = "2h";
const dbConfig = {
  user: process.env.DB_USER || "APP",
  password: process.env.DB_PASSWORD || "2005",
  connectString: process.env.DB_CONNECT || "localhost:1521/FREEPDB1",
};

// -------------------- ORACLE HELPERS --------------------
async function runQuery(sql, binds = {}, options = {}) {
  let conn;
  try {
    conn = await oracledb.getConnection(dbConfig);
    
    // For SELECT queries with BLOBs, we need special handling
    if (sql.trim().toUpperCase().startsWith('SELECT') && 
        (sql.includes('code') || sql.includes('dataset') || sql.includes('requirement'))) {
      
      // Use outFormat OBJECT and specify fetchInfo for BLOB columns
      const result = await conn.execute(sql, binds, { 
        ...options, 
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        fetchInfo: {
          "CODE": { type: oracledb.BUFFER },
          "DATASET": { type: oracledb.BUFFER },
          "REQUIREMENT": { type: oracledb.BUFFER }
        }
      });
      await conn.commit();
      return result;
    } else {
      const result = await conn.execute(sql, binds, { ...options, outFormat: oracledb.OUT_FORMAT_OBJECT });
      await conn.commit();
      return result;
    }
  } catch (err) {
    console.error("Oracle DB Error:", err.message);
    throw err;
  } finally {
    if (conn) await conn.close();
  }
}

// Safe data extraction from Oracle results
function extractSafeData(rows) {
  if (!rows || !Array.isArray(rows)) return [];
  
  return rows.map(row => {
    const safeRow = {};
    for (const key in row) {
      if (Object.prototype.hasOwnProperty.call(row, key)) {
        // Extract primitive values only, avoid circular references
        const value = row[key];
        if (value === null || value === undefined) {
          safeRow[key] = value;
        } else if (typeof value === 'object') {
          // Handle Oracle specific objects
          if (value instanceof Date) {
            safeRow[key] = value.toISOString();
          } else if (typeof value.toString === 'function' && !(value instanceof Buffer)) {
            safeRow[key] = value.toString();
          } else {
            safeRow[key] = value;
          }
        } else {
          safeRow[key] = value;
        }
      }
    }
    return safeRow;
  });
}

// Helper function to safely extract BLOB data
async function extractBlobData(blobData) {
  if (blobData instanceof Buffer) {
    return blobData;
  }
  
  if (typeof blobData === 'object' && blobData !== null) {
    try {
      // Try different methods to extract BLOB data
      if (typeof blobData.read === 'function') {
        return await new Promise((resolve, reject) => {
          const chunks = [];
          blobData.on('data', (chunk) => chunks.push(chunk));
          blobData.on('end', () => resolve(Buffer.concat(chunks)));
          blobData.on('error', reject);
          blobData.read();
        });
      }
      
      if (typeof blobData.getData === 'function') {
        return blobData.getData();
      }
      
      if (blobData._buffer) {
        return blobData._buffer;
      }
      
      // Last resort - convert to string
      return Buffer.from(String(blobData));
      
    } catch (error) {
      console.error("Error extracting BLOB data:", error.message);
      throw new Error(`BLOB extraction failed: ${error.message}`);
    }
  }
  
  return Buffer.from(String(blobData));
}

// -------------------- WORKER VALIDATION --------------------
async function validateWorker(workerId) {
  try {
    const sql = "SELECT * FROM users WHERE TRIM(username) = TRIM(:workerId) AND feild = 'resource_provider'";
    const result = await runQuery(sql, { workerId });
    return result.rows.length > 0;
  } catch (err) {
    console.error("Error validating worker:", err.message);
    return false;
  }
}

// -------------------- TASK MANAGEMENT --------------------
let taskQueue = [];
let taskProgressQueue = [];
let customers = {};
let taskUpdates = {};
const HEARTBEAT_TIMEOUT = 30000; // 30s

// -------------------- HELPERS --------------------
function generateUniqueCustomerId() {
  return `C${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function generateUniqueTaskId() {
  return `T${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function splitDataset(buffer, numParts) {
  if (!buffer || buffer.length === 0) return Array(numParts).fill(null);
  
  const chunkSize = Math.ceil(buffer.length / numParts);
  const chunks = [];
  for (let i = 0; i < numParts; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, buffer.length);
    chunks.push(buffer.slice(start, end));
  }
  return chunks;
}

// Parse usage data from buffer - UPDATED FOR NEW FORMAT
function parseUsageData(usageBuffer) {
  try {
    const usageText = usageBuffer.toString();
    
    // Try to parse as JSON first (for the new format)
    try {
      const jsonData = JSON.parse(usageText);
      
      // If it's an array of usage objects (new format)
      if (Array.isArray(jsonData) && jsonData.length > 0) {
        const firstEntry = jsonData[0];
        
        // Calculate averages from all entries
        const avgCpu = jsonData.reduce((sum, entry) => sum + (entry.cpu_percent || 0), 0) / jsonData.length;
        const avgMemory = jsonData.reduce((sum, entry) => sum + (entry.mem_usage_MB || 0), 0) / jsonData.length;
        const executionTime = jsonData.length; // Assuming 1 second per entry
        
        return {
          cpu: parseFloat(avgCpu.toFixed(2)),
          memory: parseFloat(avgMemory.toFixed(2)),
          executionTime: executionTime,
          timestamp: new Date().toISOString(),
          rawData: usageText,
          entriesCount: jsonData.length
        };
      }
    } catch (jsonError) {
      // If JSON parsing fails, fall back to text parsing (old format)
      console.log("Falling back to text parsing for usage data");
    }

    // Old text format parsing (for backward compatibility)
    const lines = usageText.split('\n');
    const usageData = {
      cpu: 0,
      memory: 0,
      executionTime: 0,
      timestamp: new Date().toISOString(),
      rawData: usageText
    };

    lines.forEach(line => {
      if (line.includes('CPU Usage:') || line.includes('cpu_percent')) {
        const cpuMatch = line.match(/(CPU Usage:|cpu_percent["']?\s*:\s*)([\d.]+)/);
        if (cpuMatch) usageData.cpu = parseFloat(cpuMatch[2]);
      }
      if (line.includes('Memory Usage:') || line.includes('mem_usage_MB')) {
        const memoryMatch = line.match(/(Memory Usage:|mem_usage_MB["']?\s*:\s*)([\d.]+)/);
        if (memoryMatch) usageData.memory = parseFloat(memoryMatch[2]);
      }
      if (line.includes('Execution Time:')) {
        const timeMatch = line.match(/Execution Time:\s*([\d.]+)\s*seconds/);
        if (timeMatch) usageData.executionTime = parseFloat(timeMatch[1]);
      }
      if (line.includes('Timestamp:')) {
        const timestampMatch = line.match(/Timestamp:\s*(.+)/);
        if (timestampMatch) usageData.timestamp = timestampMatch[1].trim();
      }
    });

    return usageData;
  } catch (error) {
    console.error("Error parsing usage data:", error.message);
    return {
      cpu: 0,
      memory: 0,
      executionTime: 0,
      timestamp: new Date().toISOString(),
      rawData: usageBuffer.toString()
    };
  }
}

// Check if all results are available for a customer
function areAllResultsAvailable(customerId) {
  const customerTask = customers[customerId];
  if (!customerTask) return false;
  
  // Check if we have the expected number of workers
  const assignedWorkers = customerTask.workers || [];
  if (assignedWorkers.length !== customerTask.numWorkers) {
    return false;
  }
  
  // Check if we have results from all assigned workers
  const hasAllResults = assignedWorkers.every(workerId => 
    customerTask.results && customerTask.results[workerId] && customerTask.usage && customerTask.usage[workerId]
  );
  
  return hasAllResults;
}

// Get progress information for a customer task
function getTaskProgress(customerId) {
  const customerTask = customers[customerId];
  if (!customerTask) return null;
  
  const submittedResults = Object.keys(customerTask.results || {}).length;
  const totalWorkers = customerTask.numWorkers;
  const isCompleted = areAllResultsAvailable(customerId);
  const isCancelled = cancelMap[customerId] === true;
  
  return {
    submitted: submittedResults,
    total: totalWorkers,
    percentage: totalWorkers > 0 ? Math.round((submittedResults / totalWorkers) * 100) : 0,
    isCompleted,
    isCancelled,
    canDownload: isCompleted && !isCancelled
  };
}

// Add completion notification to task updates
function addCompletionNotification(customerId) {
  const customerTask = customers[customerId];
  if (!customerTask) return;

  const completionMessage = {
    customerId,
    update: `🎉 TASK COMPLETED! All ${customerTask.numWorkers} workers have finished processing. Your results are ready for download.`,
    timestamp: new Date().toISOString(),
    status: "completed",
    isCompletion: true,
    progress: {
      submitted: customerTask.numWorkers,
      total: customerTask.numWorkers,
      percentage: 100
    }
  };

  // Add to task updates
  if (!taskUpdates[customerId]) {
    taskUpdates[customerId] = [];
  }
  taskUpdates[customerId].push(completionMessage);

  console.log(`🎯 Task ${customerId} completed - notification sent to client`);
}

// Add progress update to task updates
function addProgressUpdate(customerId, message, progress = null) {
  if (!taskUpdates[customerId]) {
    taskUpdates[customerId] = [];
  }

  const update = {
    customerId,
    update: message,
    timestamp: new Date().toISOString(),
    status: "progress"
  };

  if (progress) {
    update.progress = progress;
  }

  taskUpdates[customerId].push(update);
}

// -------------------- JWT MIDDLEWARE --------------------
function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ message: "No token provided" });

  const token = authHeader.split(" ")[1];
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Invalid token" });
    req.user = user;
    next();
  });
}

// -------------------- WORKER STATS HELPERS --------------------
async function initWorkerStats(workerId) {
  try {
    await runQuery(
      `MERGE INTO resource_provider rp
       USING (SELECT :workerId AS workerId FROM dual) src
       ON (rp.workerId = src.workerId)
       WHEN NOT MATCHED THEN
         INSERT (workerId, taskCompleted, taskPending, taskFailed, taskRunning)
         VALUES (:workerId, 0, 0, 0, 0)`,
      { workerId }
    );
  } catch (err) {
    console.error("Error initializing worker stats:", err.message);
  }
}

async function incrementWorkerStat(workerId, stat, value = 1) {
  try {
    await runQuery(
      `UPDATE resource_provider
       SET ${stat} = GREATEST(NVL(${stat},0) + :value, 0)
       WHERE workerId = :workerId`,
      { workerId, value }
    );
  } catch (err) {
    console.error("Error updating worker stats:", err.message);
  }
}

// -------------------- USAGE DATA STORAGE --------------------
async function storeWorkerUsage(workerId, customerId, taskId, usageData) {
  try {
    await runQuery(
      `INSERT INTO worker_usage_stats (
        worker_id, customer_id, task_id, cpu_usage, memory_usage, 
        execution_time, timestamp, raw_usage_data
       ) VALUES (
        :workerId, :customerId, :taskId, :cpuUsage, :memoryUsage,
        :executionTime, TO_TIMESTAMP(:timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'), :rawData
       )`,
      {
        workerId,
        customerId,
        taskId,
        cpuUsage: usageData.cpu,
        memoryUsage: usageData.memory,
        executionTime: usageData.executionTime,
        timestamp: usageData.timestamp,
        rawData: usageData.rawData
      },
      { autoCommit: true }
    );
    console.log(`📊 Stored usage data for worker ${workerId} on task ${taskId}`);
  } catch (err) {
    console.error("Error storing worker usage data:", err.message);
  }
}

// -------------------- CANCEL TASK MANAGEMENT --------------------
let cancelMap = {}; // { customerId: true/false }

// -------------------- ROUTES --------------------

// Server availability
app.get("/areyouthere", (req, res) => res.json({ iamthere: true }));

// User Registration - UPDATED FOR YOUR SCHEMA
app.post("/register", async (req, res) => {
  const { username, password, feild } = req.body;

  // Validate required fields
  if (!username || !password || !feild) {
    return res.status(400).json({ 
      success: false, 
      message: "Username, password, and field are required" 
    });
  }

  // Validate field
  if (!['client', 'resource_provider'].includes(feild)) {
    return res.status(400).json({ 
      success: false, 
      message: "Field must be either 'client' or 'resource_provider'" 
    });
  }

  // Validate length constraints
  if (username.length > 20) {
    return res.status(400).json({ 
      success: false, 
      message: "Username must be 20 characters or less" 
    });
  }

  if (password.length > 20) {
    return res.status(400).json({ 
      success: false, 
      message: "Password must be 20 characters or less" 
    });
  }

  try {
    // Check if user already exists
    const checkSql = "SELECT * FROM users WHERE username = TRIM(:username)";
    const existingUser = await runQuery(checkSql, { username });

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ 
        success: false, 
        message: "Username already exists" 
      });
    }

    // Insert new user
    const insertSql = `
      INSERT INTO users (username, password, feild) 
      VALUES (:username, :password, :feild)
    `;
    
    await runQuery(insertSql, {
      username: username.trim(),
      password: password.trim(),
      feild: feild.trim()
    }, { autoCommit: true });

    // If registering as resource provider, initialize their stats
    if (feild === 'resource_provider') {
      await runQuery(
        `INSERT INTO resource_provider (workerId, taskCompleted, taskPending, taskFailed, taskRunning)
         VALUES (:workerId, 0, 0, 0, 0)`,
        { workerId: username.trim() },
        { autoCommit: true }
      );
    }

    console.log(`✅ New ${feild} registered: ${username}`);
    
    res.json({ 
      success: true, 
      message: "User registered successfully" 
    });
  } catch (err) {
    console.error("Registration error:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Server error during registration" 
    });
  }
});

// Login - UPDATED
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const sql =
      "SELECT * FROM users WHERE TRIM(username)=TRIM(:username) AND TRIM(password)=TRIM(:password)";
    
    const result = await runQuery(sql, { username, password });
    if (result.rows.length > 0) {
      const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
      // Note: Changed from 'togo' to 'feild' to match your schema
      return res.json({ 
        success: true, 
        token, 
        message: "Login successful",
        togo: result.rows[0]["FEILD"] // This should be the 'feild' column
      });
    }
    res.status(401).json({ success: false, message: "Invalid username or password" });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Customer requests cancellation
app.post("/cancel", authenticateJWT, (req, res) => {
  const { customerId } = req.body;
  if (!customerId) return res.status(400).json({ message: "customerId required" });

  cancelMap[customerId] = true;

  // Remove from taskQueue if pending
  taskQueue = taskQueue.filter(t => t.customerId !== customerId);

  // Mark all workers for that task as canceled
  const customerTask = customers[customerId];
  if (customerTask) {
    customerTask.pendingWorkers = 0;
    customerTask.isCancelled = true;
    
    // Add cancellation notification
    addProgressUpdate(customerId, "❌ TASK CANCELLED by user. No results will be available.");
    
    // Clear worker heartbeats
    Object.keys(customerTask.workerHeartbeats || {}).forEach(workerId => {
      delete customerTask.workerHeartbeats[workerId];
    });
  }

  console.log(`🛑 Customer ${customerId} cancelled their task.`);
  res.json({ success: true, message: "Task cancelled successfully." });
});

// Worker checks if its task is cancelled
app.get("/canceltask", (req, res) => {
  const { customerId, workerId } = req.query;
  if (!customerId) return res.status(400).json({ message: "customerId required" });

  const isCancelled = cancelMap[customerId] === true;
  res.json({ cancel: isCancelled });
});

// -------------------- CUSTOMER ENDPOINTS --------------------

// Submit package
app.post(
  "/sendingpackage",
  authenticateJWT,
  upload.fields([{ name: "dataset" }, { name: "code" }, { name: "requirement" }]),
  async (req, res) => {
    try {
      const files = req.files;
      const cusname = req.body.customername;
      const numWorkers = parseInt(req.body.respn, 10) || 1;

      if (!files || !files.code) {
        return res.status(400).json({ message: "Code file is required" });
      }

      const customerId = generateUniqueCustomerId();
      const taskId = generateUniqueTaskId();

      const datasetChunks = files.dataset
        ? splitDataset(files.dataset[0].buffer, numWorkers)
        : Array(numWorkers).fill(null);

      customers[customerId] = {
        cusname,
        files: {
          code: files.code[0].buffer,
          datasetChunks,
          requirement: files.requirement ? files.requirement[0].buffer : null,
        },
        numWorkers,
        workers: [],
        results: {},
        usage: {},
        outputFiles: {}, // Initialize output files storage
        pendingWorkers: numWorkers,
        workerHeartbeats: {},
        taskId,
        customerId,
        isCompleted: false,
        isCancelled: false,
        createdAt: new Date(),
      };

      // Initialize task updates for this customer
      taskUpdates[customerId] = [];

      // Add tasks to queue for each worker
      for (let i = 0; i < numWorkers; i++) {
        taskQueue.push({ customerId, taskId });
      }

      // Store in database (using your table structure)
      try {
        await runQuery(
          `INSERT INTO files (customer_id, customername, code, dataset, requirement, num_workers)
           VALUES (:customerId, :cusname, :code, :dataset, :requirement, :numWorkers)`,
          {
            customerId,
            cusname,
            code: files.code[0].buffer,
            dataset: files.dataset ? files.dataset[0].buffer : null,
            requirement: files.requirement ? files.requirement[0].buffer : null,
            numWorkers,
          },
          { autoCommit: true }
        );
      } catch (err) {
        console.error("DB insert error:", err.message);
      }

      // Add initial progress update
      addProgressUpdate(customerId, `📦 Task queued successfully. Waiting for ${numWorkers} worker(s) to process your job...`);

      console.log(`📦 New task from customer ${cusname} (${customerId}) with ${numWorkers} workers`);
      
      res.json({ 
        customerId, 
        message: "Task queued successfully",
        numWorkers,
        taskId 
      });
    } catch (error) {
      console.error("Error in /sendingpackage:", error.message);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);

// -------------------- FILE DOWNLOAD ENDPOINTS (FIXED) --------------------

// Get stored code file - FIXED CIRCULAR REFERENCE ISSUE
app.get("/files/code/:customerId", authenticateJWT, async (req, res) => {
  const { customerId } = req.params;
  
  try {
    console.log(`🔍 Fetching code file for customer: ${customerId}`);
    
    const result = await runQuery(
      `SELECT code, customername FROM files WHERE customer_id = :customerId`,
      { customerId }
    );

    if (result.rows.length === 0) {
      console.log(`❌ Customer ${customerId} not found in database`);
      return res.status(404).json({ 
        success: false,
        message: "Customer not found" 
      });
    }

    const codeData = result.rows[0].CODE;
    const customerName = result.rows[0].CUSTOMERNAME;

    if (!codeData) {
      console.log(`❌ Code file is null for customer ${customerId}`);
      return res.status(404).json({ 
        success: false,
        message: "Code file not found or is empty" 
      });
    }

    // Use the safe blob extraction function
    const codeBuffer = await extractBlobData(codeData);
    
    if (!codeBuffer || codeBuffer.length === 0) {
      console.log(`❌ Code buffer is empty for customer ${customerId}`);
      return res.status(404).json({ 
        success: false,
        message: "Code file is empty" 
      });
    }

    console.log(`✅ Sending code file for customer ${customerId}, size: ${codeBuffer.length} bytes`);

    // Set appropriate headers for download
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="code_${customerId}.py"`);
    res.setHeader('Content-Length', codeBuffer.length);
    res.setHeader('Cache-Control', 'no-cache');
    
    res.send(codeBuffer);
    
  } catch (err) {
    console.error("❌ Error fetching code file:", err.message);
    res.status(500).json({ 
      success: false,
      message: "Error fetching code file: " + err.message
    });
  }
});

// Get stored dataset file - FIXED
app.get("/files/dataset/:customerId", authenticateJWT, async (req, res) => {
  const { customerId } = req.params;
  
  try {
    console.log(`🔍 Fetching dataset file for customer: ${customerId}`);
    
    const result = await runQuery(
      `SELECT dataset, customername FROM files WHERE customer_id = :customerId`,
      { customerId }
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: "Customer not found" 
      });
    }

    const datasetData = result.rows[0].DATASET;
    const customerName = result.rows[0].CUSTOMERNAME;

    if (!datasetData) {
      return res.status(404).json({ 
        success: false,
        message: "Dataset file not found" 
      });
    }

    // Use the safe blob extraction function
    const datasetBuffer = await extractBlobData(datasetData);
    
    if (!datasetBuffer || datasetBuffer.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: "Dataset file is empty" 
      });
    }

    console.log(`✅ Sending dataset file for customer ${customerId}, size: ${datasetBuffer.length} bytes`);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="dataset_${customerId}"`);
    res.setHeader('Content-Length', datasetBuffer.length);
    res.setHeader('Cache-Control', 'no-cache');
    
    res.send(datasetBuffer);
    
  } catch (err) {
    console.error("Error fetching dataset file:", err.message);
    res.status(500).json({ 
      success: false,
      message: "Error fetching dataset file: " + err.message
    });
  }
});

// Get stored requirement file - FIXED
app.get("/files/requirement/:customerId", authenticateJWT, async (req, res) => {
  const { customerId } = req.params;
  
  try {
    console.log(`🔍 Fetching requirement file for customer: ${customerId}`);
    
    const result = await runQuery(
      `SELECT requirement, customername FROM files WHERE customer_id = :customerId`,
      { customerId }
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: "Customer not found" 
      });
    }

    const requirementData = result.rows[0].REQUIREMENT;
    const customerName = result.rows[0].CUSTOMERNAME;

    if (!requirementData) {
      return res.status(404).json({ 
        success: false,
        message: "Requirement file not found" 
      });
    }

    // Use the safe blob extraction function
    const requirementBuffer = await extractBlobData(requirementData);
    
    if (!requirementBuffer || requirementBuffer.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: "Requirement file is empty" 
      });
    }

    console.log(`✅ Sending requirement file for customer ${customerId}, size: ${requirementBuffer.length} bytes`);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="requirements_${customerId}.txt"`);
    res.setHeader('Content-Length', requirementBuffer.length);
    res.setHeader('Cache-Control', 'no-cache');
    
    res.send(requirementBuffer);
    
  } catch (err) {
    console.error("Error fetching requirement file:", err.message);
    res.status(500).json({ 
      success: false,
      message: "Error fetching requirement file: " + err.message
    });
  }
});

// Get all file information for a customer
app.get("/files/info/:customerId", authenticateJWT, async (req, res) => {
  const { customerId } = req.params;
  
  try {
    const result = await runQuery(
      `SELECT customer_id, customername, num_workers, 
              CASE WHEN code IS NOT NULL THEN dbms_lob.getlength(code) ELSE 0 END as code_size,
              CASE WHEN dataset IS NOT NULL THEN dbms_lob.getlength(dataset) ELSE 0 END as dataset_size,
              CASE WHEN requirement IS NOT NULL THEN dbms_lob.getlength(requirement) ELSE 0 END as requirement_size
       FROM files 
       WHERE customer_id = :customerId`,
      { customerId }
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Files not found" });
    }

    const fileInfo = result.rows[0];
    const response = {
      customerId: fileInfo.CUSTOMER_ID,
      customerName: fileInfo.CUSTOMERNAME,
      numWorkers: fileInfo.NUM_WORKERS,
      files: {
        code: {
          available: fileInfo.CODE_SIZE > 0,
          size: fileInfo.CODE_SIZE,
          downloadUrl: `/files/code/${customerId}`
        },
        dataset: {
          available: fileInfo.DATASET_SIZE > 0,
          size: fileInfo.DATASET_SIZE,
          downloadUrl: `/files/dataset/${customerId}`
        },
        requirement: {
          available: fileInfo.REQUIREMENT_SIZE > 0,
          size: fileInfo.REQUIREMENT_SIZE,
          downloadUrl: `/files/requirement/${customerId}`
        }
      }
    };

    res.json(response);
  } catch (err) {
    console.error("Error fetching file info:", err.message);
    res.status(500).json({ message: "Error fetching file information" });
  }
});

// Get all customer files as ZIP
app.get("/files/all/:customerId", authenticateJWT, async (req, res) => {
  const { customerId } = req.params;
  
  try {
    const result = await runQuery(
      `SELECT customername, code, dataset, requirement FROM files WHERE customer_id = :customerId`,
      { customerId }
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Files not found" });
    }

    const files = result.rows[0];
    const customerName = files.CUSTOMERNAME;

    const archive = archiver("zip", { zlib: { level: 9 } });
    res.attachment(`files_${customerId}_${customerName}.zip`);
    archive.pipe(res);

    // Add code file
    if (files.CODE) {
      const codeBuffer = await extractBlobData(files.CODE);
      archive.append(codeBuffer, { name: `code.py` });
    }

    // Add dataset file
    if (files.DATASET) {
      const datasetBuffer = await extractBlobData(files.DATASET);
      archive.append(datasetBuffer, { name: `dataset` });
    }

    // Add requirement file
    if (files.REQUIREMENT) {
      const requirementBuffer = await extractBlobData(files.REQUIREMENT);
      archive.append(requirementBuffer, { name: `requirements.txt` });
    }

    // Add info file
    const info = {
      customerId,
      customerName,
      exportedAt: new Date().toISOString(),
      files: {
        code: files.CODE ? `code.py (${files.CODE.length} bytes)` : 'Not available',
        dataset: files.DATASET ? `dataset (${files.DATASET.length} bytes)` : 'Not available',
        requirement: files.REQUIREMENT ? `requirements.txt (${files.REQUIREMENT.length} bytes)` : 'Not available'
      }
    };
    archive.append(JSON.stringify(info, null, 2), { name: `file_info.json` });

    archive.on('error', (err) => {
      console.error('Archive error:', err.message);
      res.status(500).json({ message: "Error creating ZIP file" });
    });

    archive.finalize();
    console.log(`📦 Sent all files as ZIP for customer ${customerId}`);
    
  } catch (err) {
    console.error("Error creating files ZIP:", err.message);
    res.status(500).json({ message: "Error creating files package" });
  }
});

// Get results (with usage and output files) as ZIP - WITH COMPLETION CHECK
app.get("/getresults/:customerId", authenticateJWT, (req, res) => {
  const { customerId } = req.params;
  const customerTask = customers[customerId];
  
  if (!customerTask) {
    return res.status(404).json({ message: "Customer task not found" });
  }

  // Check if task was cancelled
  if (cancelMap[customerId]) {
    return res.status(400).json({ message: "Task was cancelled - no results available" });
  }

  // Check if all results are available
  if (!areAllResultsAvailable(customerId)) {
    const progress = getTaskProgress(customerId);
    return res.status(400).json({ 
      message: `Results not ready yet. ${progress.submitted}/${progress.total} workers have submitted results.`,
      progress: progress
    });
  }

  // Mark task as completed if not already
  if (!customerTask.isCompleted) {
    customerTask.isCompleted = true;
    customerTask.completedAt = new Date();
    
    // Add completion notification if not already added
    if (!customerTask.completionNotified) {
      addCompletionNotification(customerId);
      customerTask.completionNotified = true;
    }
  }

  try {
    const archive = archiver("zip", { zlib: { level: 9 } });
    res.attachment(`results_${customerId}.zip`);
    archive.pipe(res);

    // Add results from all workers
    Object.keys(customerTask.results).forEach(workerId => {
      const resultBuffer = customerTask.results[workerId];
      const usageBuffer = customerTask.usage[workerId];

      if (resultBuffer) {
        archive.append(resultBuffer, { name: `results/worker_${workerId}_result.txt` });
      }
      if (usageBuffer) {
        archive.append(usageBuffer, { name: `usage/worker_${workerId}_usage.txt` });
      }

      // Add output files from this worker
      if (customerTask.outputFiles && customerTask.outputFiles[workerId]) {
        const workerOutputFiles = customerTask.outputFiles[workerId];
        Object.keys(workerOutputFiles).forEach(filename => {
          archive.append(workerOutputFiles[filename], { name: `output/${workerId}/${filename}` });
        });
      }
    });

    // Add a comprehensive summary file
    const outputFilesSummary = Object.keys(customerTask.outputFiles || {}).map(workerId => {
      const files = customerTask.outputFiles[workerId] ? Object.keys(customerTask.outputFiles[workerId]) : [];
      return `✓ ${workerId} - Completed (Output files: ${files.length > 0 ? files.join(', ') : 'None'})`;
    }).join('\n');

    const summary = `TASK COMPLETION SUMMARY
=======================

Task ID: ${customerTask.taskId}
Customer ID: ${customerId}
Customer Name: ${customerTask.cusname}
Total Workers: ${customerTask.numWorkers}
Workers Completed: ${Object.keys(customerTask.results).length}
Task Created: ${customerTask.createdAt.toISOString()}
Task Completed: ${customerTask.completedAt?.toISOString() || new Date().toISOString()}

WORKER RESULTS:
${outputFilesSummary}

FILES INCLUDED:
- Individual worker results in /results/ folder
- Individual worker usage reports in /usage/ folder
- Output files generated by workers in /output/ folder
- This summary file

NOTE: Each worker processed a portion of the dataset and produced independent results.
`;
    archive.append(summary, { name: `task_summary.txt` });

    // Add task metadata
    const metadata = {
      customerId,
      taskId: customerTask.taskId,
      customerName: customerTask.cusname,
      numWorkers: customerTask.numWorkers,
      workers: Object.keys(customerTask.results),
      outputFiles: customerTask.outputFiles ? 
        Object.keys(customerTask.outputFiles).reduce((acc, workerId) => {
          acc[workerId] = Object.keys(customerTask.outputFiles[workerId]);
          return acc;
        }, {}) : {},
      completedAt: customerTask.completedAt?.toISOString() || new Date().toISOString(),
      fileStructure: {
        results: "Contains individual worker result files",
        usage: "Contains individual worker resource usage reports",
        output: "Contains output files generated by workers"
      }
    };
    archive.append(JSON.stringify(metadata, null, 2), { name: `metadata.json` });

    archive.on('error', (err) => {
      console.error('Archive error:', err.message);
      res.status(500).json({ message: "Error creating ZIP file" });
    });

    archive.finalize();
    
    console.log(`📥 Sending results ZIP for customer ${customerId} with ${Object.keys(customerTask.results).length} worker results`);
    
    // Log output files info
    const totalOutputFiles = Object.keys(customerTask.outputFiles || {}).reduce((total, workerId) => {
      return total + Object.keys(customerTask.outputFiles[workerId] || {}).length;
    }, 0);
    console.log(`📦 Included ${totalOutputFiles} output files in the ZIP`);
    
  } catch (error) {
    console.error("Error creating ZIP:", error.message);
    res.status(500).json({ message: "Error creating results package" });
  }
});

// Check task completion status
app.get("/taskstatus/:customerId", authenticateJWT, (req, res) => {
  const { customerId } = req.params;
  const customerTask = customers[customerId];
  
  if (!customerTask) {
    return res.status(404).json({ message: "Customer task not found" });
  }

  const progress = getTaskProgress(customerId);
  const response = {
    customerId,
    taskId: customerTask.taskId,
    customerName: customerTask.cusname,
    ...progress,
    workers: customerTask.workers || [],
    assignedWorkers: customerTask.workers.length,
    pendingWorkers: customerTask.pendingWorkers,
    createdAt: customerTask.createdAt,
    completedAt: customerTask.completedAt,
    isReadyForDownload: progress.canDownload
  };

  res.json(response);
});

// Get updates for customer - ENHANCED WITH COMPLETION NOTIFICATION
app.post("/getUpdate", authenticateJWT, (req, res) => {
  const { customerId } = req.body;
  if (!customerId) return res.status(400).json({ error: "customerId is required" });

  const customerTask = customers[customerId];
  if (!customerTask) {
    return res.status(404).json({ error: "Customer task not found" });
  }

  // Get updates for this customer
  const updates = taskUpdates[customerId] || [];
  
  // Clear updates after sending (or keep recent ones for history)
  taskUpdates[customerId] = updates.filter(update => 
    update.status === "completed" || update.timestamp > Date.now() - 60000 // Keep completion and recent updates
  );

  // Check if task is completed but no completion notification was sent
  if (customerTask.isCompleted && !updates.some(u => u.status === "completed")) {
    addCompletionNotification(customerId);
    // Re-fetch updates to include the new completion notification
    const updatedUpdates = taskUpdates[customerId] || [];
    taskUpdates[customerId] = updatedUpdates.filter(update => 
      update.status === "completed" || update.timestamp > Date.now() - 60000
    );
    
    return res.json({ 
      updates: updatedUpdates,
      hasUpdates: true,
      isCompleted: true
    });
  }

  // Add current progress to response
  const progress = getTaskProgress(customerId);
  const response = {
    updates: updates,
    hasUpdates: updates.length > 0,
    progress: progress,
    isCompleted: progress.isCompleted
  };

  res.json(response);
});

// Manual update endpoint
app.post("/whatistheupdate", authenticateJWT, (req, res) => {
  const { customerId, update } = req.body;
  if (!customerId || !update) return res.status(400).json({ error: "customerId and update required" });
  
  addProgressUpdate(customerId, update);
  
  res.json({ success: true, message: "Update recorded" });
});

// -------------------- WORKER ENDPOINTS --------------------

// Check if tasks are available
app.get("/askfortask", async (req, res) => {
  const { workerId } = req.query;
  
  if (!workerId) {
    return res.status(400).json({ 
      tasksAvailable: false,
      message: "workerId is required" 
    });
  }

  // Validate worker exists and is a resource provider
  const isValidWorker = await validateWorker(workerId);
  if (!isValidWorker) {
    return res.status(403).json({ 
      tasksAvailable: false,
      message: "Unauthorized: Only registered resource providers can request tasks" 
    });
  }

  const availableTasks = taskQueue.length > 0;
  res.json({ 
    tasksAvailable: availableTasks,
    queueLength: taskQueue.length,
    inProgress: taskProgressQueue.length
  });
});

// Get a task
app.post("/gettask", async (req, res) => {
  const { workerId } = req.body;
  if (!workerId) return res.status(400).json({ message: "workerId required" });
  
  // Validate worker exists and is a resource provider
  const isValidWorker = await validateWorker(workerId);
  if (!isValidWorker) {
    return res.status(403).json({ 
      message: "Unauthorized: Only registered resource providers can get tasks" 
    });
  }
  
  if (taskQueue.length === 0) {
    return res.json({ 
      taskAvailable: false,
      message: "No tasks available in queue"
    });
  }

  const task = taskQueue.shift();
  taskProgressQueue.push(task);

  const customerTask = customers[task.customerId];
  if (!customerTask) {
    // Return task to queue if customer task not found
    taskQueue.unshift(task);
    taskProgressQueue = taskProgressQueue.filter(t => t !== task);
    return res.status(404).json({ message: "Customer task not found" });
  }

  // Check if task is cancelled
  if (cancelMap[task.customerId]) {
    return res.status(400).json({ message: "Task has been cancelled" });
  }

  const workerIndex = customerTask.workers.length;
  const datasetChunk = customerTask.files.datasetChunks[workerIndex];

  // Assign worker to task
  customerTask.workers.push(workerId);
  customerTask.workerHeartbeats[workerId] = Date.now();

  // Initialize worker stats
  await initWorkerStats(workerId);
  // Update worker stats
  await incrementWorkerStat(workerId, "taskPending", 1);
  await incrementWorkerStat(workerId, "taskRunning", 1);

  // Add progress update for customer
  const progress = getTaskProgress(task.customerId);
  addProgressUpdate(
    task.customerId, 
    `🔧 Worker ${workerId} assigned to task. Progress: ${progress.submitted}/${progress.total} workers completed.`,
    progress
  );

  console.log(`🔧 Worker ${workerId} assigned to customer ${task.customerId} (chunk ${workerIndex + 1}/${customerTask.numWorkers})`);

  res.json({
    taskAvailable: true,
    taskId: task.taskId,
    customerId: task.customerId,
    customerName: customerTask.cusname,
    workerIndex: workerIndex,
    totalWorkers: customerTask.numWorkers,
    files: {
      code: customerTask.files.code.toString("base64"),
      dataset: datasetChunk ? datasetChunk.toString("base64") : null,
      requirement: customerTask.files.requirement?.toString("base64") || null,
    },
    assignment: {
      workerIndex,
      totalWorkers: customerTask.numWorkers,
      hasDataset: !!datasetChunk
    }
  });
});

// Custom multer handler for dynamic output fields
const uploadResultHandler = (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) {
      console.error("Upload error:", err.message);
      return res.status(400).json({ resp: false, message: `Upload error: ${err.message}` });
    }
    next();
  });
};

// Upload result + usage + output files
app.post(
  "/uploadresult",
  uploadResultHandler,
  async (req, res) => {
    try {
      const { workerId, customerId } = req.body;
      const files = req.files;
      
      if (!workerId || !customerId) {
        return res.status(400).json({ resp: false, message: "Missing workerId or customerId" });
      }

      // Validate worker exists and is a resource provider
      const isValidWorker = await validateWorker(workerId);
      if (!isValidWorker) {
        return res.status(403).json({ 
          resp: false, 
          message: "Unauthorized: Only registered resource providers can upload results" 
        });
      }

      // Group files by fieldname
      const fileMap = {};
      if (files) {
        files.forEach(file => {
          if (!fileMap[file.fieldname]) {
            fileMap[file.fieldname] = [];
          }
          fileMap[file.fieldname].push(file);
        });
      }

      if (!fileMap.result || !fileMap.usage) {
        return res.status(400).json({ resp: false, message: "Missing result or usage files" });
      }

      const customerTask = customers[customerId];
      if (!customerTask) {
        return res.status(400).json({ resp: false, message: "Customer task not found" });
      }

      if (!customerTask.workers.includes(workerId)) {
        return res.status(403).json({ resp: false, message: "Worker not authorized for this task" });
      }

      // Check if task is cancelled
      if (cancelMap[customerId]) {
        return res.status(400).json({ resp: false, message: "Task has been cancelled" });
      }

      // Prevent double submission
      if (customerTask.results[workerId]) {
        return res.status(400).json({ resp: false, message: "Result already submitted by this worker" });
      }

      // Store results
      customerTask.results[workerId] = fileMap.result[0].buffer;
      customerTask.usage[workerId] = fileMap.usage[0].buffer;

      // Parse and store usage data in database
      const usageData = parseUsageData(fileMap.usage[0].buffer);
      await storeWorkerUsage(workerId, customerId, customerTask.taskId, usageData);

      // Store output files if any
      const outputFiles = {};
      Object.keys(fileMap).forEach(fieldName => {
        if (fieldName.startsWith('output_')) {
          const originalFilename = fieldName.replace('output_', '');
          outputFiles[originalFilename] = fileMap[fieldName][0].buffer;
          console.log(`📁 Received output file from worker ${workerId}: ${originalFilename} (${fileMap[fieldName][0].size} bytes)`);
        }
      });

      if (Object.keys(outputFiles).length > 0) {
        customerTask.outputFiles = customerTask.outputFiles || {};
        customerTask.outputFiles[workerId] = outputFiles;
        console.log(`📦 Stored ${Object.keys(outputFiles).length} output files from worker ${workerId}: ${Object.keys(outputFiles).join(', ')}`);
      }

      customerTask.pendingWorkers = Math.max(customerTask.pendingWorkers - 1, 0);
      
      // Remove from heartbeat monitoring
      delete customerTask.workerHeartbeats[workerId];

      // Remove from progress queue if this was the last task
      if (customerTask.pendingWorkers === 0) {
        taskProgressQueue = taskProgressQueue.filter(t => t.customerId !== customerId);
      }

      // Update worker stats
      await incrementWorkerStat(workerId, "taskCompleted", 1);
      await incrementWorkerStat(workerId, "taskRunning", -1);
      await incrementWorkerStat(workerId, "taskPending", -1);

      const submittedResults = Object.keys(customerTask.results).length;
      const totalWorkers = customerTask.numWorkers;
      const progress = getTaskProgress(customerId);

      console.log(`✅ Worker ${workerId} completed task for customer ${customerId}`);
      console.log(`📊 Progress: ${submittedResults}/${totalWorkers} workers completed`);

      // Send update to customer
      let updateMessage = `Worker ${workerId} completed processing. Progress: ${submittedResults}/${totalWorkers} workers.`;
      if (Object.keys(outputFiles).length > 0) {
        updateMessage += ` Generated ${Object.keys(outputFiles).length} output files.`;
      }
      
      addProgressUpdate(customerId, updateMessage, progress);

      // Check if all results are now available
      if (areAllResultsAvailable(customerId) && !customerTask.isCompleted) {
        customerTask.isCompleted = true;
        customerTask.completedAt = new Date();
        
        // Send completion notification
        addCompletionNotification(customerId);
        customerTask.completionNotified = true;
        
        console.log(`🎉 Task ${customerId} completed by all workers - client notified`);
      }

      res.json({
        resp: true,
        success: true,
        pendingWorkers: customerTask.pendingWorkers,
        progress: {
          submitted: submittedResults,
          total: totalWorkers,
          percentage: progress.percentage,
          isCompleted: progress.isCompleted
        },
        outputFilesCount: Object.keys(outputFiles).length,
        message: `Result uploaded successfully. ${submittedResults}/${totalWorkers} workers completed.`
      });
    } catch (err) {
      console.error("❌ /uploadresult error:", err.message);
      res.status(500).json({ 
        resp: false, 
        message: "Internal server error during result upload",
        error: err.message 
      });
    }
  }
);

// -------------------- WORKER USAGE DATA ENDPOINTS --------------------

// Get usage data for a specific worker (for graphs and analytics)
app.get("/worker/usage/:workerId", async (req, res) => {
  const { workerId } = req.params;
  const { days = 30, limit = 100 } = req.query;

  try {
    // Validate worker exists and is a resource provider
    const isValidWorker = await validateWorker(workerId);
    if (!isValidWorker) {
      return res.status(403).json({ 
        success: false, 
        message: "Unauthorized: Only registered resource providers can access usage data" 
      });
    }

    const result = await runQuery(
      `SELECT 
        usage_id,
        worker_id,
        customer_id,
        task_id,
        cpu_usage,
        memory_usage,
        execution_time,
        TO_CHAR(timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"') as timestamp,
        raw_usage_data
       FROM worker_usage_stats 
       WHERE worker_id = :workerId 
         AND timestamp >= SYSDATE - :days
       ORDER BY timestamp DESC
       FETCH FIRST :limit ROWS ONLY`,
      { 
        workerId: workerId,
        days: parseInt(days), 
        limit: parseInt(limit) 
      }
    );

    // Use safe data extraction
    const safeRows = extractSafeData(result.rows);
    
    const usageStats = safeRows.map(row => ({
      usageId: row.USAGE_ID,
      workerId: row.WORKER_ID,
      customerId: row.CUSTOMER_ID,
      taskId: row.TASK_ID,
      cpuUsage: row.CPU_USAGE,
      memoryUsage: row.MEMORY_USAGE,
      executionTime: row.EXECUTION_TIME,
      timestamp: row.TIMESTAMP,
      rawUsageData: row.RAW_USAGE_DATA
    }));

    res.json({
      success: true,
      workerId,
      totalRecords: usageStats.length,
      usageStats,
      summary: {
        avgCpu: usageStats.length > 0 ? usageStats.reduce((sum, stat) => sum + (stat.cpuUsage || 0), 0) / usageStats.length : 0,
        avgMemory: usageStats.length > 0 ? usageStats.reduce((sum, stat) => sum + (stat.memoryUsage || 0), 0) / usageStats.length : 0,
        avgExecutionTime: usageStats.length > 0 ? usageStats.reduce((sum, stat) => sum + (stat.executionTime || 0), 0) / usageStats.length : 0,
        totalTasks: usageStats.length
      }
    });
  } catch (err) {
    console.error("Error fetching worker usage data:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching usage data",
      error: err.message 
    });
  }
});

// Get usage data for a specific task
app.get("/task/usage/:taskId", async (req, res) => {
  const { taskId } = req.params;

  try {
    const result = await runQuery(
      `SELECT 
        worker_id,
        cpu_usage,
        memory_usage,
        execution_time,
        TO_CHAR(timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"') as timestamp
       FROM worker_usage_stats 
       WHERE task_id = :taskId 
       ORDER BY timestamp ASC`,
      { taskId }
    );

    // Use safe data extraction
    const safeRows = extractSafeData(result.rows);
    
    const taskUsage = safeRows.map(row => ({
      workerId: row.WORKER_ID,
      cpuUsage: row.CPU_USAGE,
      memoryUsage: row.MEMORY_USAGE,
      executionTime: row.EXECUTION_TIME,
      timestamp: row.TIMESTAMP
    }));

    res.json({
      success: true,
      taskId,
      totalWorkers: taskUsage.length,
      usageStats: taskUsage,
      averages: {
        cpu: taskUsage.length > 0 ? taskUsage.reduce((sum, stat) => sum + (stat.cpuUsage || 0), 0) / taskUsage.length : 0,
        memory: taskUsage.length > 0 ? taskUsage.reduce((sum, stat) => sum + (stat.memoryUsage || 0), 0) / taskUsage.length : 0,
        executionTime: taskUsage.length > 0 ? taskUsage.reduce((sum, stat) => sum + (stat.executionTime || 0), 0) / taskUsage.length : 0
      }
    });
  } catch (err) {
    console.error("Error fetching task usage data:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching task usage data",
      error: err.message 
    });
  }
});

// Download usage data as CSV for a worker
app.get("/worker/usage/:workerId/download", async (req, res) => {
  const { workerId } = req.params;
  const { format = 'csv' } = req.query;

  try {
    // Validate worker exists and is a resource provider
    const isValidWorker = await validateWorker(workerId);
    if (!isValidWorker) {
      return res.status(403).json({ 
        success: false, 
        message: "Unauthorized: Only registered resource providers can download usage data" 
      });
    }

    const result = await runQuery(
      `SELECT 
        cpu_usage,
        memory_usage,
        execution_time,
        TO_CHAR(timestamp, 'YYYY-MM-DD HH24:MI:SS') as timestamp,
        task_id,
        customer_id
       FROM worker_usage_stats 
       WHERE worker_id = :workerId 
       ORDER BY timestamp DESC`,
      { workerId }
    );

    // Use safe data extraction
    const safeRows = extractSafeData(result.rows);

    if (format === 'json') {
      const usageData = safeRows.map(row => ({
        timestamp: row.TIMESTAMP,
        taskId: row.TASK_ID,
        customerId: row.CUSTOMER_ID,
        cpuUsage: row.CPU_USAGE,
        memoryUsage: row.MEMORY_USAGE,
        executionTime: row.EXECUTION_TIME
      }));

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=usage_${workerId.replace(/[^a-zA-Z0-9]/g, '_')}.json`);
      res.json(usageData);
    } else {
      // CSV format
      let csv = 'Timestamp,Task ID,Customer ID,CPU Usage (%),Memory Usage (MB),Execution Time (s)\n';
      
      safeRows.forEach(row => {
        csv += `"${row.TIMESTAMP}","${row.TASK_ID}","${row.CUSTOMER_ID}",${row.CPU_USAGE},${row.MEMORY_USAGE},${row.EXECUTION_TIME}\n`;
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=usage_${workerId.replace(/[^a-zA-Z0-9]/g, '_')}.csv`);
      res.send(csv);
    }
  } catch (err) {
    console.error("Error downloading usage data:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Error downloading usage data",
      error: err.message 
    });
  }
});

// Get worker performance summary
app.get("/worker/performance/:workerId", async (req, res) => {
  const { workerId } = req.params;

  try {
    // Validate worker exists and is a resource provider
    const isValidWorker = await validateWorker(workerId);
    if (!isValidWorker) {
      return res.status(403).json({ 
        success: false, 
        message: "Unauthorized: Only registered resource providers can access performance data" 
      });
    }

    const result = await runQuery(
      `SELECT 
        COUNT(*) as total_tasks,
        AVG(cpu_usage) as avg_cpu,
        AVG(memory_usage) as avg_memory,
        AVG(execution_time) as avg_execution_time,
        MAX(cpu_usage) as max_cpu,
        MAX(memory_usage) as max_memory,
        MAX(execution_time) as max_execution_time,
        MIN(timestamp) as first_task,
        MAX(timestamp) as last_task
       FROM worker_usage_stats 
       WHERE worker_id = :workerId`,
      { workerId }
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: "No usage data found for this worker" 
      });
    }

    // Use safe data extraction for the single row
    const safeRows = extractSafeData(result.rows);
    const stats = safeRows[0];

    const performance = {
      workerId,
      totalTasks: stats.TOTAL_TASKS,
      averages: {
        cpu: Math.round((stats.AVG_CPU || 0) * 100) / 100,
        memory: Math.round((stats.AVG_MEMORY || 0) * 100) / 100,
        executionTime: Math.round((stats.AVG_EXECUTION_TIME || 0) * 100) / 100
      },
      maximums: {
        cpu: stats.MAX_CPU || 0,
        memory: stats.MAX_MEMORY || 0,
        executionTime: stats.MAX_EXECUTION_TIME || 0
      },
      timeline: {
        firstTask: stats.FIRST_TASK,
        lastTask: stats.LAST_TASK
      },
      efficiency: {
        cpuEfficiency: Math.round(((stats.AVG_CPU || 0) / 100) * 10000) / 100, // Percentage of optimal CPU usage
        memoryEfficiency: Math.round(((stats.AVG_MEMORY || 0) / 4096) * 10000) / 100, // Assuming 4GB max memory
        speedEfficiency: (stats.AVG_EXECUTION_TIME || 0) > 0 ? Math.round((300 / (stats.AVG_EXECUTION_TIME || 1)) * 100) / 100 : 0 // Compared to 5min baseline
      }
    };

    res.json({
      success: true,
      performance
    });
  } catch (err) {
    console.error("Error fetching worker performance:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching performance data",
      error: err.message 
    });
  }
});

// Heartbeat endpoint
app.post("/heartbeat", async (req, res) => {
  const { workerId, customerId } = req.body;
  if (!workerId) return res.status(400).json({ message: "workerId required" });
  
  // Validate worker exists and is a resource provider
  const isValidWorker = await validateWorker(workerId);
  if (!isValidWorker) {
    return res.status(403).json({ 
      message: "Unauthorized: Only registered resource providers can send heartbeats" 
    });
  }
  
  if (customerId === "idle" || !customerId) {
    return res.json({ ok: true, status: "idle" });
  }

  const customerTask = customers[customerId];
  if (!customerTask || !customerTask.workers.includes(workerId)) {
    return res.json({ ok: false, message: "Not assigned to this task" });
  }

  // Check if task is cancelled
  if (cancelMap[customerId]) {
    return res.json({ ok: false, message: "Task has been cancelled" });
  }

  customerTask.workerHeartbeats[workerId] = Date.now();
  res.json({ ok: true, status: "active", customerId });
});

// -------------------- ENHANCED CLIENT DOCUMENTS ENDPOINTS --------------------

// Get all clients summary (for the new documents page)
app.get("/clients/summary", authenticateJWT, async (req, res) => {
  try {
    const result = await runQuery(
      `SELECT 
        customer_id,
        customername,
        num_workers,
        CASE WHEN code IS NOT NULL THEN dbms_lob.getlength(code) ELSE 0 END as code_size,
        CASE WHEN dataset IS NOT NULL THEN dbms_lob.getlength(dataset) ELSE 0 END as dataset_size,
        CASE WHEN requirement IS NOT NULL THEN dbms_lob.getlength(requirement) ELSE 0 END as requirement_size
       FROM files 
       ORDER BY customer_id DESC`
    );

    const clients = result.rows.map(row => ({
      customerId: row.CUSTOMER_ID,
      customerName: row.CUSTOMERNAME,
      numWorkers: row.NUM_WORKERS,
      files: {
        code: row.CODE_SIZE > 0,
        dataset: row.DATASET_SIZE > 0,
        requirement: row.REQUIREMENT_SIZE > 0
      },
      totalSize: row.CODE_SIZE + row.DATASET_SIZE + row.REQUIREMENT_SIZE,
      documentsUrl: `/client/documents/${row.CUSTOMER_ID}`,
      downloadUrl: `/client/documents/${row.CUSTOMER_ID}/download/all`
    }));

    res.json({
      success: true,
      totalClients: clients.length,
      totalStorage: clients.reduce((sum, client) => sum + client.totalSize, 0),
      clients
    });
  } catch (err) {
    console.error("Error fetching clients summary:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching clients summary",
      error: err.message 
    });
  }
});

// Get client documents with enhanced information
app.get("/client/documents/:customerId", authenticateJWT, async (req, res) => {
  const { customerId } = req.params;
  
  try {
    // First, get basic file information from files table
    const filesResult = await runQuery(
      `SELECT customer_id, customername, num_workers, 
              code, dataset, requirement,
              CASE WHEN code IS NOT NULL THEN dbms_lob.getlength(code) ELSE 0 END as code_size,
              CASE WHEN dataset IS NOT NULL THEN dbms_lob.getlength(dataset) ELSE 0 END as dataset_size,
              CASE WHEN requirement IS NOT NULL THEN dbms_lob.getlength(requirement) ELSE 0 END as requirement_size
       FROM files 
       WHERE customer_id = :customerId`,
      { customerId }
    );

    if (filesResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: "No documents found for this customer" 
      });
    }

    const fileInfo = filesResult.rows[0];
    
    // Get usage data for this customer
    const usageResult = await runQuery(
      `SELECT worker_id, task_id, cpu_usage, memory_usage, execution_time,
              TO_CHAR(timestamp, 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"') as timestamp,
              raw_usage_data
       FROM worker_usage_stats 
       WHERE customer_id = :customerId 
       ORDER BY timestamp DESC`,
      { customerId }
    );

    // Use safe data extraction
    const safeUsageRows = extractSafeData(usageResult.rows);
    
    const usageStats = safeUsageRows.map(row => ({
      workerId: row.WORKER_ID,
      taskId: row.TASK_ID,
      cpuUsage: row.CPU_USAGE,
      memoryUsage: row.MEMORY_USAGE,
      executionTime: row.EXECUTION_TIME,
      timestamp: row.TIMESTAMP,
      rawUsageData: row.RAW_USAGE_DATA
    }));

    // Get task completion information from memory
    const customerTask = customers[customerId];
    let taskStatus = null;
    let outputFilesInfo = null;

    if (customerTask) {
      const progress = getTaskProgress(customerId);
      taskStatus = {
        customerId,
        taskId: customerTask.taskId,
        customerName: customerTask.cusname,
        ...progress,
        workers: customerTask.workers || [],
        assignedWorkers: customerTask.workers.length,
        pendingWorkers: customerTask.pendingWorkers,
        createdAt: customerTask.createdAt,
        completedAt: customerTask.completedAt,
        isReadyForDownload: progress.canDownload
      };

      // Get output files information
      if (customerTask.outputFiles) {
        outputFilesInfo = Object.keys(customerTask.outputFiles).map(workerId => ({
          workerId,
          files: Object.keys(customerTask.outputFiles[workerId]).map(filename => ({
            name: filename,
            size: customerTask.outputFiles[workerId][filename].length,
            downloadUrl: `/getresults/${customerId}` // Output files are included in results ZIP
          }))
        }));
      }
    }

    // Get additional statistics
    const statsResult = await runQuery(
      `SELECT 
        COUNT(*) as total_usage_records,
        AVG(cpu_usage) as avg_cpu,
        AVG(memory_usage) as avg_memory,
        AVG(execution_time) as avg_execution_time,
        COUNT(DISTINCT worker_id) as unique_workers
       FROM worker_usage_stats 
       WHERE customer_id = :customerId`,
      { customerId }
    );

    const stats = statsResult.rows[0] || {};

    const response = {
      success: true,
      customerId: fileInfo.CUSTOMER_ID,
      customerName: fileInfo.CUSTOMERNAME,
      numWorkers: fileInfo.NUM_WORKERS,
      statistics: {
        totalUsageRecords: stats.TOTAL_USAGE_RECORDS || 0,
        uniqueWorkers: stats.UNIQUE_WORKERS || 0,
        avgCpu: parseFloat(stats.AVG_CPU || 0).toFixed(2),
        avgMemory: parseFloat(stats.AVG_MEMORY || 0).toFixed(2),
        avgExecutionTime: parseFloat(stats.AVG_EXECUTION_TIME || 0).toFixed(2)
      },
      documents: {
        // Input files
        inputFiles: {
          code: {
            available: fileInfo.CODE_SIZE > 0,
            size: fileInfo.CODE_SIZE,
            downloadUrl: `/files/code/${customerId}`,
            filename: `code_${customerId}.py`
          },
          dataset: {
            available: fileInfo.DATASET_SIZE > 0,
            size: fileInfo.DATASET_SIZE,
            downloadUrl: `/files/dataset/${customerId}`,
            filename: `dataset_${customerId}`
          },
          requirement: {
            available: fileInfo.REQUIREMENT_SIZE > 0,
            size: fileInfo.REQUIREMENT_SIZE,
            downloadUrl: `/files/requirement/${customerId}`,
            filename: `requirements_${customerId}.txt`
          }
        },
        // Usage statistics
        usageStats: {
          totalRecords: usageStats.length,
          workers: [...new Set(usageStats.map(stat => stat.workerId))],
          summary: {
            avgCpu: usageStats.length > 0 ? usageStats.reduce((sum, stat) => sum + (stat.cpuUsage || 0), 0) / usageStats.length : 0,
            avgMemory: usageStats.length > 0 ? usageStats.reduce((sum, stat) => sum + (stat.memoryUsage || 0), 0) / usageStats.length : 0,
            avgExecutionTime: usageStats.length > 0 ? usageStats.reduce((sum, stat) => sum + (stat.executionTime || 0), 0) / usageStats.length : 0
          },
          data: usageStats
        },
        // Output files (if available)
        outputFiles: outputFilesInfo || [],
        // Task status
        taskStatus: taskStatus
      },
      downloadOptions: {
        allFiles: `/client/documents/${customerId}/download/all`,
        inputFilesOnly: `/client/documents/${customerId}/download/inputs`,
        resultsOnly: `/getresults/${customerId}`,
        usageReport: `/client/documents/${customerId}/download/usage`
      }
    };

    res.json(response);
  } catch (err) {
    console.error("Error fetching client documents:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching client documents",
      error: err.message 
    });
  }
});

// Helper function to detect file extension from buffer
async function getFileExtension(buffer) {
  try {
    // Simple detection based on file signatures
    const signatures = {
      'ffd8ffe0': '.jpg',
      '89504e47': '.png',
      '47494638': '.gif',
      '25504446': '.pdf',
      '504b0304': '.zip',
      '504b0506': '.zip',
      '504b0708': '.zip',
      '377abcaf': '.7z',
      '1f8b08': '.gz',
      '424d': '.bmp',
      '494433': '.mp3',
      '000001ba': '.mpg',
      '000001b3': '.mpg',
      '3026b275': '.wmv',
      '52494646': '.avi',
      '4f676753': '.ogg',
      '664c6143': '.flac',
      '4d546864': '.mid',
      'd0cf11e0': '.msi', // Also .doc, .xls, .ppt
      '504b34': '.jar',
      '7b5c7274': '.rtf',
      '25215053': '.eps',
      '25504446': '.pdf',
      '2525454f': '.pdf',
      '255044462d': '.pdf'
    };

    const hex = buffer.slice(0, 8).toString('hex').toLowerCase();
    
    for (const [signature, extension] of Object.entries(signatures)) {
      if (hex.startsWith(signature.toLowerCase())) {
        return extension;
      }
    }
    
    // Check for text files
    const text = buffer.slice(0, 1000).toString();
    if (text.includes('<?xml') || text.includes('<html')) return '.html';
    if (text.includes('{') && text.includes('}')) return '.json';
    if (text.includes(',') && text.split('\n')[0].split(',').length > 1) return '.csv';
    
    return ''; // Unknown extension
  } catch (err) {
    return '';
  }
}

// Helper function to format file size
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Enhanced download all documents endpoint
app.get("/client/documents/:customerId/download/all", authenticateJWT, async (req, res) => {
  const { customerId } = req.params;
  
  try {
    // Get files from database
    const filesResult = await runQuery(
      `SELECT customername, code, dataset, requirement FROM files WHERE customer_id = :customerId`,
      { customerId }
    );

    if (filesResult.rows.length === 0) {
      return res.status(404).json({ message: "No documents found for this customer" });
    }

    const files = filesResult.rows[0];
    const customerName = files.CUSTOMERNAME;

    const archive = archiver("zip", { zlib: { level: 9 } });
    res.attachment(`client_documents_${customerId}_${customerName}.zip`);
    archive.pipe(res);

    // Add input files with proper extensions
    if (files.CODE) {
      const codeBuffer = await extractBlobData(files.CODE);
      archive.append(codeBuffer, { name: `input_files/code.py` });
    }
    if (files.DATASET) {
      const datasetBuffer = await extractBlobData(files.DATASET);
      // Try to determine dataset file extension
      const datasetExtension = await getFileExtension(datasetBuffer);
      archive.append(datasetBuffer, { name: `input_files/dataset${datasetExtension}` });
    }
    if (files.REQUIREMENT) {
      const requirementBuffer = await extractBlobData(files.REQUIREMENT);
      archive.append(requirementBuffer, { name: `input_files/requirements.txt` });
    }

    // Get enhanced usage data
    const usageResult = await runQuery(
      `SELECT worker_id, task_id, cpu_usage, memory_usage, execution_time,
              TO_CHAR(timestamp, 'YYYY-MM-DD HH24:MI:SS') as timestamp,
              raw_usage_data
       FROM worker_usage_stats 
       WHERE customer_id = :customerId 
       ORDER BY timestamp ASC`,
      { customerId }
    );

    // Create enhanced usage reports
    if (usageResult.rows.length > 0) {
      const safeUsageRows = extractSafeData(usageResult.rows);
      
      // Detailed CSV report
      let usageCsv = 'Timestamp,Worker ID,Task ID,CPU Usage (%),Memory Usage (MB),Execution Time (s),Raw Data\n';
      safeUsageRows.forEach(row => {
        const rawData = row.RAW_USAGE_DATA ? `"${row.RAW_USAGE_DATA.replace(/"/g, '""')}"` : '';
        usageCsv += `"${row.TIMESTAMP}","${row.WORKER_ID}","${row.TASK_ID}",${row.CPU_USAGE},${row.MEMORY_USAGE},${row.EXECUTION_TIME},${rawData}\n`;
      });
      
      archive.append(usageCsv, { name: `reports/usage_statistics_detailed.csv` });

      // Summary CSV report
      let summaryCsv = 'Worker ID,Avg CPU (%),Avg Memory (MB),Total Execution Time (s),Records Count\n';
      const workerSummaries = safeUsageRows.reduce((acc, row) => {
        if (!acc[row.WORKER_ID]) {
          acc[row.WORKER_ID] = {
            workerId: row.WORKER_ID,
            cpuSum: 0,
            memorySum: 0,
            executionSum: 0,
            count: 0
          };
        }
        acc[row.WORKER_ID].cpuSum += row.CPU_USAGE;
        acc[row.WORKER_ID].memorySum += row.MEMORY_USAGE;
        acc[row.WORKER_ID].executionSum += row.EXECUTION_TIME;
        acc[row.WORKER_ID].count++;
        return acc;
      }, {});

      Object.values(workerSummaries).forEach(summary => {
        summaryCsv += `"${summary.workerId}",${(summary.cpuSum / summary.count).toFixed(2)},${(summary.memorySum / summary.count).toFixed(2)},${summary.executionSum.toFixed(2)},${summary.count}\n`;
      });
      
      archive.append(summaryCsv, { name: `reports/usage_statistics_summary.csv` });

      // Enhanced usage summary JSON
      const usageSummary = {
        customerId,
        customerName,
        totalUsageRecords: safeUsageRows.length,
        uniqueWorkers: Object.keys(workerSummaries).length,
        timeRange: {
          start: safeUsageRows[0]?.TIMESTAMP,
          end: safeUsageRows[safeUsageRows.length - 1]?.TIMESTAMP
        },
        summary: {
          overall: {
            avgCpu: safeUsageRows.reduce((sum, row) => sum + (row.CPU_USAGE || 0), 0) / safeUsageRows.length,
            avgMemory: safeUsageRows.reduce((sum, row) => sum + (row.MEMORY_USAGE || 0), 0) / safeUsageRows.length,
            totalExecutionTime: safeUsageRows.reduce((sum, row) => sum + (row.EXECUTION_TIME || 0), 0)
          },
          byWorker: Object.values(workerSummaries).map(ws => ({
            workerId: ws.workerId,
            avgCpu: (ws.cpuSum / ws.count),
            avgMemory: (ws.memorySum / ws.count),
            totalExecutionTime: ws.executionSum,
            recordsCount: ws.count
          }))
        }
      };
      archive.append(JSON.stringify(usageSummary, null, 2), { name: `reports/usage_summary.json` });
    }

    // Add enhanced task information
    const customerTask = customers[customerId];
    if (customerTask) {
      const taskInfo = {
        customerId,
        taskId: customerTask.taskId,
        customerName: customerTask.cusname,
        numWorkers: customerTask.numWorkers,
        workers: customerTask.workers || [],
        status: getTaskProgress(customerId),
        timeline: {
          createdAt: customerTask.createdAt,
          startedAt: customerTask.workers.length > 0 ? customerTask.createdAt : null,
          completedAt: customerTask.completedAt
        },
        outputFiles: customerTask.outputFiles ? 
          Object.keys(customerTask.outputFiles).reduce((acc, workerId) => {
            acc[workerId] = {
              files: Object.keys(customerTask.outputFiles[workerId]),
              totalSize: Object.values(customerTask.outputFiles[workerId]).reduce((sum, buffer) => sum + buffer.length, 0)
            };
            return acc;
          }, {}) : {}
      };
      archive.append(JSON.stringify(taskInfo, null, 2), { name: `task_information.json` });
    }

    // Add file manifest
    const codeSize = files.CODE ? (await extractBlobData(files.CODE)).length : 0;
    const datasetSize = files.DATASET ? (await extractBlobData(files.DATASET)).length : 0;
    const requirementSize = files.REQUIREMENT ? (await extractBlobData(files.REQUIREMENT)).length : 0;
    
    const manifest = {
      customerId,
      customerName,
      exportedAt: new Date().toISOString(),
      totalFiles: [
        files.CODE ? 'input_files/code.py' : null,
        files.DATASET ? 'input_files/dataset' : null,
        files.REQUIREMENT ? 'input_files/requirements.txt' : null,
        'reports/usage_statistics_detailed.csv',
        'reports/usage_statistics_summary.csv',
        'reports/usage_summary.json',
        'task_information.json',
        'README.txt'
      ].filter(Boolean).length,
      fileSizes: {
        code: codeSize,
        dataset: datasetSize,
        requirement: requirementSize
      }
    };
    archive.append(JSON.stringify(manifest, null, 2), { name: `manifest.json` });

    // Add comprehensive readme
    const readme = `CLIENT DOCUMENTS ARCHIVE
=======================

Customer Information:
-------------------
Customer ID: ${customerId}
Customer Name: ${customerName}
Export Date: ${new Date().toISOString()}

Folder Structure:
----------------
input_files/     - Original input files submitted by client
reports/         - Detailed usage statistics and performance reports

Files Included:
--------------
INPUT FILES:
1. code.py                    - Main code file
2. dataset                    - Dataset file (if provided)
3. requirements.txt           - Requirements file (if provided)

USAGE REPORTS:
4. usage_statistics_detailed.csv - Detailed usage data with timestamps
5. usage_statistics_summary.csv  - Worker-wise summary statistics
6. usage_summary.json           - Comprehensive usage analysis

METADATA:
7. task_information.json       - Complete task metadata and execution details
8. manifest.json              - File manifest and sizes
9. README.txt                 - This file

Usage:
------
- Input files can be used to reproduce the task
- Usage reports provide insights into resource consumption
- Task information gives execution context and timing
- Use the manifest to understand the archive contents

Notes:
------
- All timestamps are in UTC
- File sizes are in bytes
- CPU usage is measured in percentage
- Memory usage is measured in MB
- Execution time is measured in seconds

Total Files: ${manifest.totalFiles}
Total Size: ${formatFileSize(Object.values(manifest.fileSizes).reduce((a, b) => a + b, 0))}
`;
    archive.append(readme, { name: `README.txt` });

    archive.on('error', (err) => {
      console.error('Archive error:', err.message);
      res.status(500).json({ message: "Error creating documents archive" });
    });

    archive.on('end', () => {
      console.log(`📦 Sent enhanced documents archive for client ${customerId}`);
    });

    archive.finalize();
    
  } catch (err) {
    console.error("Error creating enhanced documents archive:", err.message);
    res.status(500).json({ message: "Error creating documents package" });
  }
});

// Delete client documents (optional cleanup endpoint)
app.delete("/client/documents/:customerId", authenticateJWT, async (req, res) => {
  const { customerId } = req.params;
  
  try {
    // Check if customer exists
    const checkResult = await runQuery(
      `SELECT customer_id FROM files WHERE customer_id = :customerId`,
      { customerId }
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: "Client documents not found" 
      });
    }

    // Delete from database (cascade should handle related records)
    await runQuery(
      `DELETE FROM files WHERE customer_id = :customerId`,
      { customerId },
      { autoCommit: true }
    );

    // Clean up memory
    delete customers[customerId];
    delete taskUpdates[customerId];
    delete cancelMap[customerId];

    console.log(`🗑️ Deleted documents for client ${customerId}`);
    
    res.json({
      success: true,
      message: "Client documents deleted successfully"
    });
  } catch (err) {
    console.error("Error deleting client documents:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Error deleting client documents",
      error: err.message 
    });
  }
});

// Search clients by name or ID
app.get("/clients/search", authenticateJWT, async (req, res) => {
  const { query } = req.query;
  
  if (!query || query.length < 2) {
    return res.status(400).json({ 
      success: false, 
      message: "Search query must be at least 2 characters long" 
    });
  }

  try {
    const result = await runQuery(
      `SELECT 
        customer_id,
        customername,
        num_workers,
        CASE WHEN code IS NOT NULL THEN dbms_lob.getlength(code) ELSE 0 END as code_size,
        CASE WHEN dataset IS NOT NULL THEN dbms_lob.getlength(dataset) ELSE 0 END as dataset_size,
        CASE WHEN requirement IS NOT NULL THEN dbms_lob.getlength(requirement) ELSE 0 END as requirement_size
       FROM files 
       WHERE UPPER(customer_id) LIKE UPPER(:query) 
          OR UPPER(customername) LIKE UPPER(:query)
       ORDER BY customer_id DESC`,
      { query: `%${query}%` }
    );

    const clients = result.rows.map(row => ({
      customerId: row.CUSTOMER_ID,
      customerName: row.CUSTOMERNAME,
      numWorkers: row.NUM_WORKERS,
      files: {
        code: row.CODE_SIZE > 0,
        dataset: row.DATASET_SIZE > 0,
        requirement: row.REQUIREMENT_SIZE > 0
      },
      totalSize: row.CODE_SIZE + row.DATASET_SIZE + row.REQUIREMENT_SIZE,
      documentsUrl: `/client/documents/${row.CUSTOMER_ID}`,
      downloadUrl: `/client/documents/${row.CUSTOMER_ID}/download/all`
    }));

    res.json({
      success: true,
      query,
      totalResults: clients.length,
      clients
    });
  } catch (err) {
    console.error("Error searching clients:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Error searching clients",
      error: err.message 
    });
  }
});

// Update the existing /admin/clients endpoint to use the new format
app.get("/admin/clients", authenticateJWT, async (req, res) => {
  try {
    const result = await runQuery(
      `SELECT 
        customer_id,
        customername,
        num_workers,
        CASE WHEN code IS NOT NULL THEN dbms_lob.getlength(code) ELSE 0 END as code_size,
        CASE WHEN dataset IS NOT NULL THEN dbms_lob.getlength(dataset) ELSE 0 END as dataset_size,
        CASE WHEN requirement IS NOT NULL THEN dbms_lob.getlength(requirement) ELSE 0 END as requirement_size
       FROM files 
       ORDER BY customer_id DESC`
    );

    const clients = result.rows.map(row => ({
      customerId: row.CUSTOMER_ID,
      customerName: row.CUSTOMERNAME,
      numWorkers: row.NUM_WORKERS,
      files: {
        code: row.CODE_SIZE > 0,
        dataset: row.DATASET_SIZE > 0,
        requirement: row.REQUIREMENT_SIZE > 0
      },
      totalSize: row.CODE_SIZE + row.DATASET_SIZE + row.REQUIREMENT_SIZE,
      documentsUrl: `/client/documents/${row.CUSTOMER_ID}`,
      downloadUrl: `/client/documents/${row.CUSTOMER_ID}/download/all`
    }));

    res.json({
      success: true,
      totalClients: clients.length,
      totalStorage: clients.reduce((sum, client) => sum + client.totalSize, 0),
      clients
    });
  } catch (err) {
    console.error("Error fetching clients list:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching clients list",
      error: err.message 
    });
  }
});

// Download only input files
app.get("/client/documents/:customerId/download/inputs", authenticateJWT, async (req, res) => {
  const { customerId } = req.params;
  
  try {
    const filesResult = await runQuery(
      `SELECT customername, code, dataset, requirement FROM files WHERE customer_id = :customerId`,
      { customerId }
    );

    if (filesResult.rows.length === 0) {
      return res.status(404).json({ message: "No input files found for this customer" });
    }

    const files = filesResult.rows[0];
    const customerName = files.CUSTOMERNAME;

    const archive = archiver("zip", { zlib: { level: 9 } });
    res.attachment(`input_files_${customerId}_${customerName}.zip`);
    archive.pipe(res);

    if (files.CODE) {
      const codeBuffer = await extractBlobData(files.CODE);
      archive.append(codeBuffer, { name: `code.py` });
    }
    if (files.DATASET) {
      const datasetBuffer = await extractBlobData(files.DATASET);
      archive.append(datasetBuffer, { name: `dataset` });
    }
    if (files.REQUIREMENT) {
      const requirementBuffer = await extractBlobData(files.REQUIREMENT);
      archive.append(requirementBuffer, { name: `requirements.txt` });
    }

    // Add file info
    const fileInfo = {
      customerId,
      customerName,
      exportedAt: new Date().toISOString(),
      files: {
        code: files.CODE ? `code.py (${(await extractBlobData(files.CODE)).length} bytes)` : 'Not available',
        dataset: files.DATASET ? `dataset (${(await extractBlobData(files.DATASET)).length} bytes)` : 'Not available',
        requirement: files.REQUIREMENT ? `requirements.txt (${(await extractBlobData(files.REQUIREMENT)).length} bytes)` : 'Not available'
      }
    };
    archive.append(JSON.stringify(fileInfo, null, 2), { name: `file_info.json` });

    archive.on('error', (err) => {
      console.error('Archive error:', err.message);
      res.status(500).json({ message: "Error creating input files archive" });
    });

    archive.finalize();
    console.log(`📦 Sent input files archive for client ${customerId}`);
    
  } catch (err) {
    console.error("Error creating input files archive:", err.message);
    res.status(500).json({ message: "Error creating input files package" });
  }
});

// Download usage report only
app.get("/client/documents/:customerId/download/usage", authenticateJWT, async (req, res) => {
  const { customerId } = req.params;
  const { format = 'csv' } = req.query;
  
  try {
    const usageResult = await runQuery(
      `SELECT worker_id, task_id, cpu_usage, memory_usage, execution_time,
              TO_CHAR(timestamp, 'YYYY-MM-DD HH24:MI:SS') as timestamp,
              raw_usage_data
       FROM worker_usage_stats 
       WHERE customer_id = :customerId 
       ORDER BY timestamp ASC`,
      { customerId }
    );

    if (usageResult.rows.length === 0) {
      return res.status(404).json({ message: "No usage data found for this customer" });
    }

    const safeUsageRows = extractSafeData(usageResult.rows);

    if (format === 'json') {
      const usageData = safeUsageRows.map(row => ({
        timestamp: row.TIMESTAMP,
        workerId: row.WORKER_ID,
        taskId: row.TASK_ID,
        cpuUsage: row.CPU_USAGE,
        memoryUsage: row.MEMORY_USAGE,
        executionTime: row.EXECUTION_TIME,
        rawUsageData: row.RAW_USAGE_DATA
      }));

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=usage_report_${customerId}.json`);
      res.json({
        customerId,
        totalRecords: usageData.length,
        usageData
      });
    } else {
      // CSV format
      let csv = 'Timestamp,Worker ID,Task ID,CPU Usage (%),Memory Usage (MB),Execution Time (s),Raw Data\n';
      
      safeUsageRows.forEach(row => {
        const rawData = row.RAW_USAGE_DATA ? `"${row.RAW_USAGE_DATA.replace(/"/g, '""')}"` : '';
        csv += `"${row.TIMESTAMP}","${row.WORKER_ID}","${row.TASK_ID}",${row.CPU_USAGE},${row.MEMORY_USAGE},${row.EXECUTION_TIME},${rawData}\n`;
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=usage_report_${customerId}.csv`);
      res.send(csv);
    }

    console.log(`📊 Sent usage report for client ${customerId}`);
    
  } catch (err) {
    console.error("Error creating usage report:", err.message);
    res.status(500).json({ message: "Error creating usage report" });
  }
});

// -------------------- HEARTBEAT MONITOR --------------------
setInterval(async () => {
  const now = Date.now();
  
  for (const task of [...taskProgressQueue]) {
    const customerTask = customers[task.customerId];
    if (!customerTask) {
      // Remove invalid task from progress queue
      taskProgressQueue = taskProgressQueue.filter(t => t !== task);
      continue;
    }

    // Skip if task is completed or cancelled
    if (customerTask.isCompleted || cancelMap[task.customerId]) {
      taskProgressQueue = taskProgressQueue.filter(t => t !== task);
      continue;
    }

    for (const workerId of [...customerTask.workers]) {
      // Skip workers who already submitted results
      if (!customerTask.workerHeartbeats[workerId]) continue;

      const lastBeat = customerTask.workerHeartbeats[workerId];
      if (now - lastBeat > HEARTBEAT_TIMEOUT) {
        console.log(`⚠️ Worker ${workerId} missed heartbeat for customer ${task.customerId}. Releasing slot.`);

        // Remove worker from task
        customerTask.workers = customerTask.workers.filter(id => id !== workerId);
        delete customerTask.workerHeartbeats[workerId];
        
        // Remove any partial results from this worker
        delete customerTask.results[workerId];
        delete customerTask.usage[workerId];
        if (customerTask.outputFiles) {
          delete customerTask.outputFiles[workerId];
        }

        // Add task back to queue for reassignment
        taskQueue.push({ customerId: task.customerId, taskId: task.taskId });

        // Update worker stats
        await incrementWorkerStat(workerId, "taskFailed", 1);
        await incrementWorkerStat(workerId, "taskRunning", -1);
        await incrementWorkerStat(workerId, "taskPending", -1);

        // Notify customer about worker timeout
        addProgressUpdate(
          task.customerId, 
          `⚠️ Worker ${workerId} timed out. Reassigning task...`
        );

        console.log(`🔄 Task reassigned for customer ${task.customerId} after worker ${workerId} timeout`);
      }
    }
  }
}, 5000);

// -------------------- WORKER STATS ENDPOINT --------------------
app.get("/workerstats/:workerId", async (req, res) => {
  const { workerId } = req.params;
  try {
    // Validate worker exists and is a resource provider
    const isValidWorker = await validateWorker(workerId);
    if (!isValidWorker) {
      return res.status(403).json({ 
        message: "Unauthorized: Only registered resource providers can access stats" 
      });
    }

    const result = await runQuery(
      `SELECT * FROM resource_provider WHERE workerId = :workerId`,
      { workerId }
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "Worker not found" });
    
    // Use safe data extraction
    const safeRows = extractSafeData(result.rows);
    const stats = safeRows[0];
    
    res.json({
      WORKERID: stats.WORKERID,
      TASKCOMPLETED: stats.TASKCOMPLETED,
      TASKPENDING: stats.TASKPENDING,
      TASKFAILED: stats.TASKFAILED,
      TASKRUNNING: stats.TASKRUNNING
    });
  } catch (err) {
    console.error("Error fetching worker stats:", err.message);
    res.status(500).json({ 
      message: "Server error fetching worker stats",
      error: err.message 
    });
  }
});

app.post("/workerstats", async (req, res) => {
  const { workerId } = req.body;
  
  try {
    // Validate worker exists and is a resource provider
    const isValidWorker = await validateWorker(workerId);
    if (!isValidWorker) {
      return res.status(403).json({ 
        message: "Unauthorized: Only registered resource providers can access stats" 
      });
    }

    const sql = `SELECT * FROM resource_provider WHERE workerId = TRIM(:workerId)`;
    const result = await runQuery(sql, { workerId });
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Worker stats not found" });
    }
    
    // Use safe data extraction
    const safeRows = extractSafeData(result.rows);
    const stats = safeRows[0];
    
    res.json({
      WORKERID: stats.WORKERID,
      TASKCOMPLETED: stats.TASKCOMPLETED,
      TASKPENDING: stats.TASKPENDING,
      TASKFAILED: stats.TASKFAILED,
      TASKRUNNING: stats.TASKRUNNING
    });
  } catch (err) {
    console.error("Error in /workerstats:", err.message);
    res.status(500).json({ 
      message: "Server error",
      error: err.message 
    });
  }
});

// -------------------- ADMIN ENDPOINTS --------------------
app.get("/admin/tasks", authenticateJWT, (req, res) => {
  const taskList = Object.keys(customers).map(customerId => {
    const task = customers[customerId];
    const progress = getTaskProgress(customerId);
    const outputFilesCount = task.outputFiles ? 
      Object.keys(task.outputFiles).reduce((total, workerId) => total + Object.keys(task.outputFiles[workerId] || {}).length, 0) : 0;
    
    return {
      customerId,
      taskId: task.taskId,
      customerName: task.cusname,
      numWorkers: task.numWorkers,
      progress,
      assignedWorkers: task.workers.length,
      outputFilesCount,
      isCancelled: cancelMap[customerId] === true,
      isCompleted: task.isCompleted,
      completionNotified: task.completionNotified,
      createdAt: task.createdAt,
      completedAt: task.completedAt
    };
  });

  res.json({
    totalTasks: taskList.length,
    queueLength: taskQueue.length,
    inProgress: taskProgressQueue.length,
    tasks: taskList
  });
});

// -------------------- START SERVER --------------------
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📊 Task system ready - Monitoring ${HEARTBEAT_TIMEOUT/1000}s heartbeats`);
  console.log(`🔐 JWT authentication enabled`);
  console.log(`🗄️  Database: ${dbConfig.connectString}`);
  console.log(`🎯 Completion notifications: ACTIVE`);
  console.log(`📦 Output files support: ENABLED`);
  console.log(`📈 Worker usage analytics: ENABLED`);
  console.log(`🔒 Worker validation: ACTIVE (only registered resource providers allowed)`);
  console.log(`📁 File retrieval endpoints: ACTIVE`);
  console.log(`📋 Enhanced client documents endpoints: ACTIVE`);
  console.log(`🔍 Client search functionality: ACTIVE`);
  console.log(`📊 Client statistics: ACTIVE`);
});

export default app;