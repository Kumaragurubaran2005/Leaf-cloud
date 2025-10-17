import express from "express";
import multer from "multer";
import oracledb from "oracledb";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

// -------------------- GLOBAL STATE --------------------
let resourceId = [];          // Array of worker IDs who claimed task
let update = "not started";   // Current update string
let isTaskAvailable = false;  // Is there a task to do
let noofrep = 1;              // Number of workers allowed
let cusname;
let customerIdentifier;
// Heartbeat tracking
let workerHeartbeats = {};
const HEARTBEAT_TIMEOUT = 30000; // 30s timeout

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

// -------------------- ROUTES --------------------

// Server availability
app.get("/areyouthere", (req, res) => {
  res.json({ iamthere: true });
});

// Upload files (dataset and requirement optional)
app.post(
  "/sendingpackage",
  upload.fields([
    { name: "dataset" },
    { name: "code" },
    { name: "requirement" },
  ]),
  async (req, res) => {
    const files = req.files;
    cusname = req.body.customername;
    noofrep = parseInt(req.body.respn, 10) || 1;

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const hours = String(now.getHours()).padStart(2, "0");
    const minutes = String(now.getMinutes()).padStart(2, "0");
    const seconds = String(now.getSeconds()).padStart(2, "0");
    const milliseconds = String(now.getMilliseconds()).padStart(3, "0");

    customerIdentifier = `${year}${month}${day}${hours}${minutes}${seconds}${milliseconds}`;
    console.log("Customer ID:", customerIdentifier);

    if (!files.code) {
      return res.status(400).json({ message: "Code file is required" });
    }

    try {
      const sql = `
        INSERT INTO files (code, dataset, requirement, customername, hint)
        VALUES (:code, :dataset, :requirement, :cusname, :hint)
      `;

      const bind = {
        cusname,
        code: files.code[0].buffer,
        dataset: files.dataset ? files.dataset[0].buffer : null,
        requirement: files.requirement ? files.requirement[0].buffer : null,
        hint: customerIdentifier,
      };

      const result = await runQuery(sql, bind, { autoCommit: true });
      if (result.rowsAffected > 0) {
        isTaskAvailable = true;
        resourceId = []; // Reset previous workers for new task
        update = "not started";
        res.json({ received: true });
      } else {
        res.json({ received: false });
      }
    } catch (err) {
      console.error(err);
      res.status(500).send(err.message);
    }
  }
);

// Worker asks if a task exists
app.get("/askfortask", (req, res) => {
  res.json({ isTaskThere: isTaskAvailable });
});

// Worker tries to claim the task
app.post("/iamin", (req, res) => {
  const workerId = req.body.workerId;

  if (resourceId.length < noofrep) {
    resourceId.push(workerId);
    return res.json({ isaccepted: true });
  } else {
    isTaskThere=false
    return res.json({ isaccepted: false });
    
  }
});

// Worker heartbeat
app.post("/heartbeat", (req, res) => {
  const { workerId } = req.body;
  if (resourceId.includes(workerId)) {
    workerHeartbeats[workerId] = Date.now();
    return res.json({ ok: true });
  }
  res.json({ ok: false, message: "Not assigned to this task" });
});

// Send files to the chosen worker
app.post("/getfiles", async (req, res) => {
  const { workerId } = req.body;
  if (!resourceId.includes(workerId)) {
    return res.json({ response: "You are not authorized" });
  }

  try {
    const sql = `
      SELECT code, dataset, requirement
      FROM files
      WHERE customername = :cusname AND hint = :hint
    `;

    const options = {
      fetchInfo: {
        CODE: { type: oracledb.BUFFER },
        DATASET: { type: oracledb.BUFFER },
        REQUIREMENT: { type: oracledb.BUFFER },
      },
    };

    const result = await runQuery(sql, { cusname, hint: customerIdentifier }, options);

    if (!result.rows || result.rows.length === 0) {
      return res.json({ response: "No files found" });
    }

    const row = result.rows[0];
    res.json({
      code: row[0] ? row[0].toString("base64") : null,
      dataset: row[1] ? row[1].toString("base64") : null,
      requirement: row[2] ? row[2].toString("base64") : null,
    });
  } catch (err) {
    console.error("Error fetching files:", err);
    res.status(500).json({ error: err.message });
  }
});

// Worker sends status updates
app.post("/updates", (req, res) => {
  update = req.body.update;
  res.json({ isReceived: true });
});

// Client polls for updates
app.get("/whatsTheupdate", (req, res) => {
  res.json({ updates: update });
});

// Worker uploads result file
app.post("/getresult", upload.single("result"), async (req, res) => {
  const cusname = req.body.cusname;
  if (!req.file || !cusname) {
    return res.json({ resp: false });
  }

  try {
    const sql = `INSERT INTO result_files (customername, result_file) VALUES (:cusname, :result)`;
    const bind = { cusname, result: req.file.buffer };
    const result = await runQuery(sql, bind);
    res.json({ resp: result.rowsAffected > 0 });
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

// Client fetches result
app.post("/sendresult", async (req, res) => {
  const { cusname } = req.body;

  try {
    const sql = `SELECT result_file FROM result_files WHERE customername = :cusname`;
    const result = await runQuery(sql, { cusname }, { outFormat: oracledb.OUT_FORMAT_OBJECT });

    if (result.rows.length === 0) {
      return res.json({ response: "No result available" });
    }

    const file = result.rows[0].RESULT_FILE;
    res.json({ result: file.toString("base64") });
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

// -------------------- HEARTBEAT MONITOR --------------------
setInterval(() => {
  resourceId.forEach((workerId) => {
    const lastBeat = workerHeartbeats[workerId];
    if (lastBeat && Date.now() - lastBeat > HEARTBEAT_TIMEOUT) {
      console.log(`⚠️ Worker ${workerId} missed heartbeat. Releasing lock.`);
      resourceId = resourceId.filter((id) => id !== workerId);
      delete workerHeartbeats[workerId];
    }
  });
}, 5000);

// -------------------- START SERVER --------------------
app.listen(5000, () => console.log("✅ Server running on port 5000"));
