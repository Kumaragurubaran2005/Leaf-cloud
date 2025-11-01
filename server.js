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
    const result = await conn.execute(sql, binds, options);
    await conn.commit();
    return result;
  } catch (err) {
    console.error("Oracle DB Error:", err);
    throw err;
  } finally {
    if (conn) await conn.close();
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

// Parse usage data from buffer
function parseUsageData(usageBuffer) {
  try {
    const usageText = usageBuffer.toString();
    const lines = usageText.split('\n');
    const usageData = {
      cpu: 0,
      memory: 0,
      executionTime: 0,
      timestamp: new Date().toISOString(),
      rawData: usageText
    };

    lines.forEach(line => {
      if (line.includes('CPU Usage:')) {
        const cpuMatch = line.match(/CPU Usage:\s*([\d.]+)%/);
        if (cpuMatch) usageData.cpu = parseFloat(cpuMatch[1]);
      }
      if (line.includes('Memory Usage:')) {
        const memoryMatch = line.match(/Memory Usage:\s*([\d.]+)\s*MB/);
        if (memoryMatch) usageData.memory = parseFloat(memoryMatch[1]);
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
    console.error("Error parsing usage data:", error);
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
    console.error("Error initializing worker stats:", err);
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
    console.error("Error updating worker stats:", err);
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
    console.error("Error storing worker usage data:", err);
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
    console.error("Registration error:", err);
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
    console.log(result)
    if (result.rows.length > 0) {
      const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
      // Note: Changed from 'togo' to 'feild' to match your schema
      return res.json({ 
        success: true, 
        token, 
        message: "Login successful",
        togo: result.rows[0][2] // This should be the 'feild' column
      });
    }
    res.status(401).json({ success: false, message: "Invalid username or password" });
  } catch (err) {
    console.error(err);
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

      // Store in database (without created_at field that doesn't exist)
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
      console.error("Error in /sendingpackage:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);

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
      console.error('Archive error:', err);
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
    console.error("Error creating ZIP:", error);
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
app.get("/askfortask", (req, res) => {
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
      console.error("Upload error:", err);
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
      console.error("❌ /uploadresult error:", err);
      res.status(500).json({ 
        resp: false, 
        message: "Internal server error during result upload" 
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
      { workerId, days: parseInt(days), limit: parseInt(limit) }
    );

    const usageStats = result.rows.map(row => ({
      usageId: row[0],
      workerId: row[1],
      customerId: row[2],
      taskId: row[3],
      cpuUsage: row[4],
      memoryUsage: row[5],
      executionTime: row[6],
      timestamp: row[7],
      rawUsageData: row[8]
    }));

    res.json({
      success: true,
      workerId,
      totalRecords: usageStats.length,
      usageStats,
      summary: {
        avgCpu: usageStats.reduce((sum, stat) => sum + (stat.cpuUsage || 0), 0) / usageStats.length || 0,
        avgMemory: usageStats.reduce((sum, stat) => sum + (stat.memoryUsage || 0), 0) / usageStats.length || 0,
        avgExecutionTime: usageStats.reduce((sum, stat) => sum + (stat.executionTime || 0), 0) / usageStats.length || 0,
        totalTasks: usageStats.length
      }
    });
  } catch (err) {
    console.error("Error fetching worker usage data:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching usage data" 
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

    const taskUsage = result.rows.map(row => ({
      workerId: row[0],
      cpuUsage: row[1],
      memoryUsage: row[2],
      executionTime: row[3],
      timestamp: row[4]
    }));

    res.json({
      success: true,
      taskId,
      totalWorkers: taskUsage.length,
      usageStats: taskUsage,
      averages: {
        cpu: taskUsage.reduce((sum, stat) => sum + (stat.cpuUsage || 0), 0) / taskUsage.length || 0,
        memory: taskUsage.reduce((sum, stat) => sum + (stat.memoryUsage || 0), 0) / taskUsage.length || 0,
        executionTime: taskUsage.reduce((sum, stat) => sum + (stat.executionTime || 0), 0) / taskUsage.length || 0
      }
    });
  } catch (err) {
    console.error("Error fetching task usage data:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching task usage data" 
    });
  }
});

// Download usage data as CSV for a worker
app.get("/worker/usage/:workerId/download", async (req, res) => {
  const { workerId } = req.params;
  const { format = 'csv' } = req.query;

  try {
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

    if (format === 'json') {
      const usageData = result.rows.map(row => ({
        timestamp: row[3],
        taskId: row[4],
        customerId: row[5],
        cpuUsage: row[0],
        memoryUsage: row[1],
        executionTime: row[2]
      }));

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=usage_${workerId}.json`);
      res.json(usageData);
    } else {
      // CSV format
      let csv = 'Timestamp,Task ID,Customer ID,CPU Usage (%),Memory Usage (MB),Execution Time (s)\n';
      
      result.rows.forEach(row => {
        csv += `"${row[3]}","${row[4]}","${row[5]}",${row[0]},${row[1]},${row[2]}\n`;
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=usage_${workerId}.csv`);
      res.send(csv);
    }
  } catch (err) {
    console.error("Error downloading usage data:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error downloading usage data" 
    });
  }
});

// Get worker performance summary
app.get("/worker/performance/:workerId", async (req, res) => {
  const { workerId } = req.params;

  try {
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

    const stats = result.rows[0];
    const performance = {
      workerId,
      totalTasks: stats[0],
      averages: {
        cpu: Math.round(stats[1] * 100) / 100,
        memory: Math.round(stats[2] * 100) / 100,
        executionTime: Math.round(stats[3] * 100) / 100
      },
      maximums: {
        cpu: stats[4],
        memory: stats[5],
        executionTime: stats[6]
      },
      timeline: {
        firstTask: stats[7],
        lastTask: stats[8]
      },
      efficiency: {
        cpuEfficiency: Math.round((stats[1] / 100) * 10000) / 100, // Percentage of optimal CPU usage
        memoryEfficiency: Math.round((stats[2] / 4096) * 10000) / 100, // Assuming 4GB max memory
        speedEfficiency: stats[3] > 0 ? Math.round((300 / stats[3]) * 100) / 100 : 0 // Compared to 5min baseline
      }
    };

    res.json({
      success: true,
      performance
    });
  } catch (err) {
    console.error("Error fetching worker performance:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching performance data" 
    });
  }
});

// Heartbeat endpoint
app.post("/heartbeat", (req, res) => {
  const { workerId, customerId } = req.body;
  if (!workerId) return res.status(400).json({ message: "workerId required" });
  
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
    const result = await runQuery(
      `SELECT * FROM resource_provider WHERE workerId = :workerId`,
      { workerId }
    );
    if (result.rows.length === 0) return res.status(404).json({ message: "Worker not found" });
    
    const stats = result.rows[0];
    res.json({
      WORKERID: stats[0],
      TASKCOMPLETED: stats[1],
      TASKPENDING: stats[2],
      TASKFAILED: stats[3],
      TASKRUNNING: stats[4]
    });
  } catch (err) {
    console.error("Error fetching worker stats:", err);
    res.status(500).json({ message: "Server error fetching worker stats" });
  }
});

app.post("/workerstats", async (req, res) => {
  const { workerId } = req.body;
  
  try {
    const sql = `SELECT * FROM resource_provider WHERE workerId = TRIM(:workerId)`;
    const result = await runQuery(sql, { workerId });
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Worker stats not found" });
    }
    
    res.json({
      WORKERID: result.rows[0][0],
      TASKCOMPLETED: result.rows[0][1],
      TASKPENDING: result.rows[0][2],
      TASKFAILED: result.rows[0][3],
      TASKRUNNING: result.rows[0][4]
    });
  } catch (err) {
    console.error("Error in /workerstats:", err);
    res.status(500).json({ message: "Server error" });
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
});

export default app;