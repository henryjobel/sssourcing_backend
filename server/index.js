import "dotenv/config";
import express from "express";
import multer from "multer";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import { v2 as cloudinary } from "cloudinary";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const uploadDir = path.join(root, "public", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) throw new Error("MONGODB_URI is required. Copy .env.example to .env and add your Atlas connection string.");
const mongoClient = new MongoClient(mongoUri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});
const databaseName = process.env.MONGODB_DB || "sssourcing";
if (!process.env.CLOUDINARY_URL) throw new Error("CLOUDINARY_URL is required for media uploads.");
let users;
let contentCollection;
let messages;
let media;
let databaseReady;

const adminEmail = (process.env.ADMIN_EMAIL || "admin@ssssourcing.com").toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD || "ChangeMe123!";
const app = express();
const port = Number(process.env.PORT || 4000);
const jwtSecret = process.env.JWT_SECRET || "development-only-change-this-secret";
app.disable("x-powered-by");
app.use(express.json({ limit: "4mb" }));
app.use("/uploads", express.static(uploadDir, { maxAge: "7d" }));

async function initializeDatabase() {
  if (!databaseReady) {
    databaseReady = (async () => {
      await mongoClient.connect();
      await mongoClient.db("admin").command({ ping: 1 });
      const db = mongoClient.db(databaseName);
      users = db.collection("users");
      contentCollection = db.collection("content");
      messages = db.collection("messages");
      media = db.collection("media");
      await Promise.all([
        users.createIndex({ email: 1 }, { unique: true }),
        contentCollection.createIndex({ key: 1 }, { unique: true }),
        messages.createIndex({ createdAt: -1 }),
        media.createIndex({ publicId: 1 }, { unique: true }),
        media.createIndex({ originalPath: 1 }, { unique: true }),
      ]);
      const existingUser = await users.findOne({ email: adminEmail });
      if (!existingUser) {
        await users.insertOne({ email: adminEmail, password_hash: bcrypt.hashSync(adminPassword, 12), name: "Administrator", createdAt: new Date() });
      }
    })().catch((error) => {
      databaseReady = undefined;
      throw error;
    });
  }
  return databaseReady;
}

app.use(async (_req, _res, next) => {
  try {
    await initializeDatabase();
    next();
  } catch (error) {
    next(error);
  }
});

app.get("/", (_req, res) => res.json({ service: "SSS Sourcing API", status: "ok" }));
app.get("/api/health", (_req, res) => res.json({ status: "ok", database: "connected" }));

function auth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try {
    req.user = jwt.verify(token, jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: "Session expired" });
  }
}

const attempts = new Map();
app.post("/api/auth/login", async (req, res, next) => {
  try {
  const ip = req.ip;
  const state = attempts.get(ip) || { count: 0, until: 0 };
  if (state.until > Date.now()) return res.status(429).json({ error: "Too many attempts. Try again shortly." });
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const user = await users.findOne({ email });
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    state.count += 1;
    if (state.count >= 5) { state.until = Date.now() + 15 * 60_000; state.count = 0; }
    attempts.set(ip, state);
    return res.status(401).json({ error: "Invalid email or password" });
  }
  attempts.delete(ip);
  const token = jwt.sign({ sub: user._id.toString(), email: user.email, name: user.name }, jwtSecret, { expiresIn: "8h" });
  res.json({ token, user: { email: user.email, name: user.name } });
  } catch (error) { next(error); }
});

app.get("/api/auth/me", auth, (req, res) => res.json({ user: req.user }));

app.get("/api/content", async (_req, res, next) => {
  try {
    const row = await contentCollection.findOne({ key: "site" });
    res.json({ content: row?.payload || null, updatedAt: row?.updatedAt || null });
  } catch (error) { next(error); }
});

app.put("/api/content", auth, async (req, res, next) => {
  try {
  const content = req.body?.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return res.status(400).json({ error: "A valid content object is required" });
  }
  const existing = await contentCollection.findOne({ key: "site" });
  const existingProducts = Array.isArray(existing?.payload?.products) ? existing.payload.products : [];
  const incomingProducts = Array.isArray(content.products) ? content.products : [];
  const incomingSources = new Set(incomingProducts.map((product) => product?.sourcePath).filter(Boolean));
  const protectedProducts = existingProducts.filter((product) => (
    typeof product?.sourcePath === "string"
    && product.sourcePath.startsWith("/assets/products photos/")
    && !incomingSources.has(product.sourcePath)
  ));
  if (protectedProducts.length && incomingProducts.length < existingProducts.length) {
    content.products = [...incomingProducts, ...protectedProducts];
  }
  const payload = JSON.stringify(content);
  if (payload.length > 3_500_000) return res.status(413).json({ error: "Content is too large" });
  await contentCollection.updateOne({ key: "site" }, { $set: { payload: content, updatedAt: new Date() } }, { upsert: true });
  res.json({ ok: true });
  } catch (error) { next(error); }
});

const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml", "application/pdf", "video/mp4", "video/webm", "video/quicktime"]);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(null, allowed.has(file.mimetype)) });
app.post("/api/upload", auth, upload.single("file"), async (req, res, next) => {
  try {
  if (!req.file) return res.status(400).json({ error: "Choose a supported image, video or PDF" });
  const baseName = path.basename(req.file.originalname, path.extname(req.file.originalname)).replace(/[^a-z0-9-]/gi, "-").slice(0, 60) || "media";
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({
      folder: "sssourcing",
      public_id: `${Date.now()}-${baseName}`,
      resource_type: "auto",
      use_filename: false,
    }, (error, uploaded) => error ? reject(error) : resolve(uploaded));
    stream.end(req.file.buffer);
  });
  await media.updateOne(
    { publicId: result.public_id },
    { $set: {
      originalPath: `cloudinary://${result.public_id}`,
      name: req.file.originalname,
      url: result.secure_url,
      publicId: result.public_id,
      resourceType: result.resource_type,
      format: result.format,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      updatedAt: new Date(),
    }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  res.status(201).json({ url: result.secure_url, name: req.file.originalname, publicId: result.public_id });
  } catch (error) { next(error); }
});

app.post("/api/messages", async (req, res, next) => {
  try {
  const fields = ["name", "email", "subject", "message"];
  const values = fields.map((key) => String(req.body?.[key] || "").trim());
  if (values.some((value) => !value) || !/^\S+@\S+\.\S+$/.test(values[1])) {
    return res.status(400).json({ error: "Please complete all fields with a valid email" });
  }
  if (values.some((value) => value.length > 5000)) return res.status(400).json({ error: "Message is too long" });
  await messages.insertOne({ name: values[0], email: values[1], subject: values[2], message: values[3], status: "new", createdAt: new Date() });
  res.status(201).json({ ok: true, message: "Thank you. Your message has been received." });
  } catch (error) { next(error); }
});

app.get("/api/messages", auth, async (_req, res, next) => {
  try {
    const rows = await messages.find().sort({ createdAt: -1 }).toArray();
    res.json({ messages: rows.map(({ _id, createdAt, ...item }) => ({ ...item, id: _id.toString(), created_at: createdAt })) });
  } catch (error) { next(error); }
});
app.patch("/api/messages/:id", auth, async (req, res, next) => {
  try {
  const status = ["new", "read", "replied"].includes(req.body?.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: "Invalid status" });
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid message ID" });
  await messages.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status } });
  res.json({ ok: true });
  } catch (error) { next(error); }
});
app.delete("/api/messages/:id", auth, async (req, res, next) => {
  try {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: "Invalid message ID" });
  await messages.deleteOne({ _id: new ObjectId(req.params.id) });
  res.json({ ok: true });
  } catch (error) { next(error); }
});

const dist = path.join(root, "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("/{*splat}", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error?.code === "LIMIT_FILE_SIZE" ? 413 : 500).json({ error: error?.message || "Server error" });
});

async function start() {
  await initializeDatabase();
  app.listen(port, () => console.log(`SSS Sourcing server running on http://localhost:${port} (MongoDB: ${databaseName})`));
}

if (!process.env.VERCEL) {
  start().catch((error) => {
    console.error("Could not start server:", error.message);
    process.exit(1);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => { await mongoClient.close(); process.exit(0); });
}

export default app;
