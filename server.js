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
const upload = multer({ storage });

// -------------------- ENV / CONFIG --------------------
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";
const JWT_EXPIRES_IN = "2h";

const dbConfig = {
  user: process.env.DB_USER || "APPUSER",
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
let taskUpdates = [];
const HEARTBEAT_TIMEOUT = 30000; // 30s

// -------------------- HELPERS --------------------
function generateUniqueCustomerId() {
  return `C${Date.now()}${Math.floor(Math.random() * 1000)}`;
}
function generateUniqueTaskId() {
  return `T${Date.now()}${Math.floor(Math.random() * 1000)}`;
}
function splitDataset(buffer, numParts) {
  const chunkSize = Math.ceil(buffer.length / numParts);
  const chunks = [];
  for (let i = 0; i < numParts; i++) {
    const start = i * chunkSize;
    const end = start + chunkSize;
    chunks.push(buffer.slice(start, end));
  }
  return chunks;
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

// -------------------- ROUTES --------------------

// Server availability
app.get("/areyouthere", (req, res) => res.json({ iamthere: true }));

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const sql =
      "SELECT * FROM users WHERE TRIM(username)=TRIM(:username) AND TRIM(password)=TRIM(:password)";
    const result = await runQuery(sql, { username, password });
    if (result.rows.length > 0) {
      const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
      return res.json({ success: true, token, message: "Login successful" });
    }
    res.status(401).json({ success: false, message: "Invalid username or password" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// -------------------- CUSTOMER ENDPOINTS --------------------

// Submit package
app.post(
  "/sendingpackage",
  authenticateJWT,
  upload.fields([{ name: "dataset" }, { name: "code" }, { name: "requirement" }]),
  async (req, res) => {
    const files = req.files;
    const cusname = req.body.customername;
    const numWorkers = parseInt(req.body.respn, 10) || 1;

    if (!files.code) return res.status(400).json({ message: "Code file is required" });

    const customerId = generateUniqueCustomerId();
    const taskId = generateUniqueTaskId();

    const datasetChunks = files.dataset
      ? numWorkers > 1
        ? splitDataset(files.dataset[0].buffer, numWorkers)
        : [files.dataset[0].buffer]
      : [null];

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
      pendingWorkers: numWorkers,
      workerHeartbeats: {},
      taskId,
      customerId,
    };

    for (let i = 0; i < numWorkers; i++) taskQueue.push({ customerId, taskId });

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

    res.json({ customerId, message: "Task queued successfully" });
  }
);

// Get results (with usage)
// Get combined results as ZIP
app.get("/getresults/:customerId", authenticateJWT, (req, res) => {
  const { customerId } = req.params;
  const customerTask = customers[customerId];
  if (!customerTask) return res.status(404).json({ message: "Customer not found" });

  const archive = archiver("zip", { zlib: { level: 9 } });
  res.attachment(`results_${customerId}.zip`);
  archive.pipe(res);

  // Add all results and usage files
  Object.keys(customerTask.results).forEach(workerId => {
    const resultBuffer = customerTask.results[workerId];
    const usageBuffer = customerTask.usage[workerId];

    if (resultBuffer) archive.append(resultBuffer, { name: `result_${workerId}.txt` });
    if (usageBuffer) archive.append(usageBuffer, { name: `usage_${workerId}.txt` });
  });

  archive.finalize();
});


// -------------------- WORKER ENDPOINTS --------------------

// Check if tasks are available
app.get("/askfortask", (req, res) => res.json({ tasksAvailable: taskQueue.length > 0 }));

// Get a task
app.post("/gettask", (req, res) => {
  const { workerId } = req.body;
  if (!workerId) return res.status(400).json({ message: "workerId required" });
  if (taskQueue.length === 0) return res.json({ taskAvailable: false });

  const task = taskQueue.shift();
  taskProgressQueue.push(task);

  const customerTask = customers[task.customerId];
  const workerIndex = customerTask.workers.length;
  const datasetChunk = customerTask.files.datasetChunks[workerIndex];

  customerTask.workers.push(workerId);
  customerTask.workerHeartbeats[workerId] = Date.now();

  res.json({
    taskId: task.taskId,
    customerId: task.customerId,
    files: {
      code: customerTask.files.code.toString("base64"),
      dataset: datasetChunk ? datasetChunk.toString("base64") : null,
      requirement: customerTask.files.requirement?.toString("base64") || null,
    },
  });
});

// Upload result + usage
app.post(
  "/uploadresult",
  upload.fields([
    { name: "result", maxCount: 1 },
    { name: "usage", maxCount: 1 },
  ]),
  (req, res) => {
    try {
      const { workerId, customerId } = req.body;
      const files = req.files;

      if (!workerId || !customerId)
        return res
          .status(400)
          .json({ resp: false, message: "Missing workerId or customerId" });

      if (!files || !files.result || !files.usage)
        return res
          .status(400)
          .json({ resp: false, message: "Missing result or usage files" });

      const customerTask = customers[customerId];
      if (!customerTask)
        return res
          .status(400)
          .json({ resp: false, message: "Customer not found" });

      if (!customerTask.workers.includes(workerId))
        return res
          .status(403)
          .json({ resp: false, message: "Worker not authorized" });

      // Decrement pendingWorkers every time, but avoid negative
      customerTask.pendingWorkers = Math.max(
        customerTask.pendingWorkers - 1,
        0
      );

      // Always update result & usage (overwrite if re-upload)
      customerTask.results[workerId] = files.result[0].buffer;
      customerTask.usage[workerId] = files.usage[0].buffer;
      delete customerTask.workerHeartbeats[workerId];

      
if (customerTask.pendingWorkers >=0) {
  console.log(
  `✅ Received result and usage from worker ${workerId} for customer ${customerId}`
);
  console.log(`Pending workers: ${customerTask.pendingWorkers}`);
}


      res.json({
        resp: true,
        pendingWorkers: customerTask.pendingWorkers,
      });
    } catch (err) {
      console.error("❌ /uploadresult error:", err);
      res
        .status(500)
        .json({ resp: false, message: "Internal server error" });
    }
  }
);


// Heartbeat endpoint
app.post("/heartbeat", (req, res) => {
  const { workerId, customerId } = req.body;
  if (!workerId) return res.status(400).json({ message: "workerId required" });
  if (customerId === "idle") return res.json({ ok: true });

  const customerTask = customers[customerId];
  if (!customerTask || !customerTask.workers.includes(workerId))
    return res.json({ ok: false, message: "Not assigned to this task" });

  customerTask.workerHeartbeats[workerId] = Date.now();
  res.json({ ok: true });
});

// -------------------- HEARTBEAT MONITOR --------------------
setInterval(() => {
  const now = Date.now();
  taskProgressQueue.forEach(task => {
    const customerTask = customers[task.customerId];
    if (!customerTask) return;

    // Skip completed tasks
    if (customerTask.pendingWorkers <= 0) return;

    customerTask.workers.forEach(workerId => {
      const lastBeat = customerTask.workerHeartbeats[workerId];
      if (!lastBeat) return;

      if (now - lastBeat > HEARTBEAT_TIMEOUT) {
        console.log(`⚠️ Worker ${workerId} missed heartbeat. Releasing slot.`);

        customerTask.workers = customerTask.workers.filter(id => id !== workerId);
        delete customerTask.workerHeartbeats[workerId];
        customerTask.pendingWorkers += 1;

        taskQueue.push({ customerId: task.customerId, taskId: task.taskId });
      }
    });
  });
}, 5000);


// Get updates for a customer
app.post("/getUpdate", (req, res) => {
  const { customerId } = req.body;
  if (!customerId) return res.status(400).json({ error: "customerId is required" });

  const updatesForCustomer = taskUpdates.filter(t => t.customerId === customerId);
  taskUpdates = taskUpdates.filter(t => t.customerId !== customerId);

  res.json({ updates: updatesForCustomer.length > 0 ? updatesForCustomer : [] });
});

app.post("/whatistheupdate", (req, res) => {
  const { customerId, update } = req.body;
  if (!customerId || !update)
    return res.status(400).json({ error: "customerId and update required" });

  // Push the update into the global updates queue
  taskUpdates.push({ customerId, update });

  res.json({ success: true });
});


// -------------------- START SERVER --------------------
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
