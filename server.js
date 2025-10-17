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

// Map to store customer tasks
let customers = {};
/*
customers = {
  [customerId]: {
    cusname: "Alice",
    files: { code, dataset, requirement },
    numWorkers: 2,
    workers: [],       // array of workerIds who claimed this task
    results: {},       // workerId -> result buffer
    pendingWorkers: 2
  }
}
*/

// Queue representing all pending worker slots
let taskQueue = [];
/*
taskQueue = [
  { customerId: "C123", taskId: "T1" },
  { customerId: "C123", taskId: "T2" },
  ...
]
*/

const HEARTBEAT_TIMEOUT = 30000; // 30s heartbeat timeout

// -------------------- HELPERS --------------------

// Generate unique IDs using timestamp + random number
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

// Upload task files
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

    if (!files.code) {
      return res.status(400).json({ message: "Code file is required" });
    }

    // Generate unique customer ID
    const customerId = generateUniqueCustomerId();

    // Save customer task in memory
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
    };

    // Push task slots into the queue (one per worker)
    for (let i = 0; i < numWorkers; i++) {
      const taskId = generateUniqueTaskId();
      taskQueue.push({ customerId, taskId });
    }

    // Optional: save files to DB for persistence
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

// Fetch results for a customer
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

// Worker asks if a task is available
app.get("/askfortask", (req, res) => {
  res.json({ tasksAvailable: taskQueue.length > 0 });
});

// Worker claims a task
app.post("/gettask", (req, res) => {
  const { workerId } = req.body;

  if (taskQueue.length === 0) return res.json({ taskAvailable: false });

  const task = taskQueue.shift();
  const { customerId, taskId } = task;
  const customerTask = customers[customerId];

  // Assign worker to this task
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

// Worker sends heartbeat
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

  res.json({ resp: true, pendingWorkers: customerTask.pendingWorkers });
});

// -------------------- HEARTBEAT MONITOR --------------------
setInterval(() => {
  Object.values(customers).forEach((task) => {
    task.workers.forEach((workerId) => {
      const lastBeat = task.workerHeartbeats[workerId];
      if (lastBeat && Date.now() - lastBeat > HEARTBEAT_TIMEOUT) {
        console.log(`⚠️ Worker ${workerId} missed heartbeat. Releasing slot.`);
        task.workers = task.workers.filter((id) => id !== workerId);
        delete task.workerHeartbeats[workerId];
        task.pendingWorkers += 1;
        // Optionally, push task back into queue for another worker
        const taskId = generateUniqueTaskId();
        taskQueue.push({ customerId: Object.keys(customers).find(key => customers[key] === task), taskId });
      }
    });
  });
}, 5000);

// -------------------- START SERVER --------------------
app.listen(5000, () => console.log("✅ Server running on port 5000"));
