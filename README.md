# sssourcing_backend

Backend API for the SSS Sourcing website and CMS. It provides admin authentication, editable site content, Cloudinary media uploads, contact-message management, and MongoDB persistence.

## Setup

Requirements: Node.js 20 or newer, MongoDB, and Cloudinary.

```bash
npm install
cp .env.example .env
npm run dev
```

The API starts on `http://localhost:4000` by default.

## Environment variables

Copy `.env.example` to `.env` and replace every placeholder. Never commit `.env`.

- `MONGODB_URI`: MongoDB connection string
- `MONGODB_DB`: database name (defaults to `sssourcing`)
- `CLOUDINARY_URL`: Cloudinary connection URL
- `ADMIN_EMAIL`: initial administrator email
- `ADMIN_PASSWORD`: initial administrator password
- `JWT_SECRET`: long random secret used to sign sessions
- `CORS_ORIGINS`: comma-separated frontend origins allowed to call the API
- `PORT`: HTTP port (defaults to `4000`)

The initial administrator is created on the first successful startup. Use strong production values for `ADMIN_PASSWORD` and `JWT_SECRET` before starting the service.

## Production

```bash
npm ci --omit=dev
NODE_ENV=production npm start
```
