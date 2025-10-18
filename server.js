import express from "express";
import multer from "multer";
import oracledb from "oracledb";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

// -------------------- FILE STORAGE --------------------
const storage = multer.memoryStorage();
const upload = multer({ storage });

// -------------------- ORACLE CONFIG --------------------
const config = {
  user: "APPUSER",
  password: "2005",
  connectString: "localhost:1521/FREEPDB1",
};

async function runQuery(sql, binds = {}, options = {}) {
  let conn;
  try {
    conn = await oracledb.getConnection(config);
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

// -------------------- IN-MEMORY TASK MANAGEMENT --------------------
let taskQueue = [];
let taskProgressQueue = [];
let customers = {};
let taskUpdate = [];
const HEARTBEAT_TIMEOUT = 30000; // 30s

// -------------------- HELPERS --------------------
function generateUniqueCustomerId() {
  const now = Date.now();
  const random = Math.floor(Math.random() * 1000);
  return `C${now}${random}`;
}

function generateUniqueTaskId() {
  const now = Date.now();
  const random = Math.floor(Math.random() * 1000);
  return `T${now}${random}`;
}

// -------------------- ROUTES --------------------

// Server availability check
app.get("/areyouthere", (req, res) => {
  res.json({ iamthere: true });
});

// -------------------- CUSTOMER ROUTES --------------------
app.post(
  "/sendingpackage",
  upload.fields([
    { name: "dataset" },
    { name: "code" },
    { name: "requirement" },
  ]),
  async (req, res) => {
    const files = req.files;
    const cusname = req.body.customername;
    const numWorkers = parseInt(req.body.respn, 10) || 1;

    if (!files.code) return res.status(400).json({ message: "Code file is required" });

    const customerId = generateUniqueCustomerId();
    const taskId = generateUniqueTaskId();

    customers[customerId] = {
      cusname,
      files: {
        code: files.code[0].buffer,
        dataset: files.dataset ? files.dataset[0].buffer : null,
        requirement: files.requirement ? files.requirement[0].buffer : null,
      },
      numWorkers,
      workers: [],
      results: {},
      pendingWorkers: numWorkers,
      workerHeartbeats: {},
      taskId,
      customerId,
    };

    // Push task slots into the queue (one per worker)
    for (let i = 0; i < numWorkers; i++) {
      taskQueue.push({ customerId, taskId });
    }

    // Optional: save files to Oracle DB
    try {
      const sql = `
        INSERT INTO files (customer_id, customername, code, dataset, requirement, num_workers)
        VALUES (:customerId, :cusname, :code, :dataset, :requirement, :numWorkers)
      `;
      const bind = {
        customerId,
        cusname,
        code: files.code[0].buffer,
        dataset: files.dataset ? files.dataset[0].buffer : null,
        requirement: files.requirement ? files.requirement[0].buffer : null,
        numWorkers,
      };
      await runQuery(sql, bind, { autoCommit: true });
    } catch (err) {
      console.error("DB insert error:", err.message);
    }

    res.json({ customerId, message: "Task queued successfully" });
  }
);

app.post("/getresults", (req, res) => {
  const { customerId } = req.body;
  const customerTask = customers[customerId];
  if (!customerTask) return res.json({ response: "Customer task not found" });

  const results = Object.entries(customerTask.results).map(([workerId, buffer]) => ({
    workerId,
    result: buffer.toString("base64"),
  }));

  res.json({ results });
});

// -------------------- WORKER ROUTES --------------------
app.get("/askfortask", (req, res) => {
  res.json({ tasksAvailable: taskQueue.length > 0 });
});

// Worker claims a task
app.post("/gettask", (req, res) => {
  const { workerId } = req.body;

  if (taskQueue.length === 0) return res.json({ taskAvailable: false });

  const task = taskQueue.shift();
  taskProgressQueue.push(task);

  const { customerId, taskId } = task;
  const customerTask = customers[customerId];

  customerTask.workers.push(workerId);
  customerTask.workerHeartbeats[workerId] = Date.now();

  res.json({
    taskId,
    customerId,
    files: {
      code: customerTask.files.code.toString("base64"),
      dataset: customerTask.files.dataset?.toString("base64") || null,
      requirement: customerTask.files.requirement?.toString("base64") || null,
    },
  });
});

app.post("/whatistheupdate", (req, res) => {
  const { customerId, update } = req.body;
  if (!customerId || !update) return res.status(400).json({ error: "customerId and update required" });
  taskUpdate.push({ customerId, update });
  res.json({ success: true });
});

app.post("/getUpdate", (req, res) => {
  const { customerId } = req.body;
  if (!customerId) return res.status(400).json({ error: "customerId is required" });

  const updatesForCustomer = taskUpdate.filter(t => t.customerId === customerId);
  taskUpdate = taskUpdate.filter(t => t.customerId !== customerId);
  
  res.json({ updates: updatesForCustomer.length > 0 ? updatesForCustomer : "No updates available" });
});

// Worker heartbeat
app.post("/heartbeat", (req, res) => {
  const { workerId, customerId } = req.body;
  const customerTask = customers[customerId];
  if (!customerTask || !customerTask.workers.includes(workerId))
    return res.json({ ok: false, message: "Not assigned to this task" });

  customerTask.workerHeartbeats[workerId] = Date.now();
  res.json({ ok: true });
});

// Worker uploads result
app.post("/uploadresult", upload.single("result"), (req, res) => {
  const { workerId, customerId } = req.body;
  const resultBuffer = req.file?.buffer;
  if (!resultBuffer) return res.status(400).json({ resp: false });

  const customerTask = customers[customerId];
  if (!customerTask || !customerTask.workers.includes(workerId))
    return res.status(400).json({ resp: false, message: "Not authorized" });

  customerTask.results[workerId] = resultBuffer;
  customerTask.pendingWorkers -= 1;

  // If all workers finished, remove from taskProgressQueue
  if (customerTask.pendingWorkers <= 0) {
    taskProgressQueue = taskProgressQueue.filter(
      t => !(t.customerId === customerId && t.taskId === customerTask.taskId)
    );
  }

  res.json({ resp: true, pendingWorkers: customerTask.pendingWorkers });
});

// -------------------- HEARTBEAT MONITOR --------------------
setInterval(() => {
  const now = Date.now();

  taskProgressQueue.forEach((task) => {
    const customerTask = customers[task.customerId];
    if (!customerTask) return;

    customerTask.workers.forEach((workerId) => {
      const lastBeat = customerTask.workerHeartbeats[workerId];
      if (!lastBeat) return;

      if (now - lastBeat > HEARTBEAT_TIMEOUT) {
        console.log(`⚠️ Worker ${workerId} missed heartbeat. Releasing slot.`);

        // Remove worker from task
        customerTask.workers = customerTask.workers.filter(id => id !== workerId);
        delete customerTask.workerHeartbeats[workerId];
        customerTask.pendingWorkers += 1;

        // Re-queue original task
        taskQueue.push({ customerId: task.customerId, taskId: task.taskId });
      }
    });
  });
}, 5000);

// -------------------- START SERVER --------------------
app.listen(5000, () => console.log("✅ Server running on port 5000"));
