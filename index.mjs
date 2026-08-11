import crypto from "crypto";
import path from "path";
import fs from "fs";
import Logger from "@hackthedev/terminal-logger";
import {fileTypeFromBuffer} from "file-type";
import express from "express";

export default class dSyncFiles {
    constructor({
                    app = null
                } = {}) {
        // not really used lol
    }

    getFolderSize(folderPath) {
        const files = fs.readdirSync(folderPath);
        return files.reduce((total, file) => {
            const {size} = fs.statSync(path.join(folderPath, file));
            return total + size;
        }, 0);
    };

    sanitizeFilename(filename) {
        return filename
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-zA-Z0-9._-]/g, '_')
            .replace(/\s+/g, '_');
    }

    sha256(b) {
        return crypto.createHash("sha256").update(b).digest("hex");
    }

    getFileHash(path) {
        const finalBuf = fs.readFileSync(path);
        return this.sha256(finalBuf);
    }

    isUploadPath(basePath, finalPath) {
        const base = path.resolve(basePath);
        const final = path.resolve(finalPath);

        return final === base || final.startsWith(base + path.sep);
    }

    async registerFileUploadHandle({
                                       app = null,
                                       urlPath = null,
                                       uploadPath = null,
                                       limits = {}
                                   }) {

        // some defaults
        const {
            keepOriginalFilename = null,
            getMaxMB = null,
            getMaxFolderSizeMB = null,
            getAllowedMimes = null,
            getUploadPath = null,
            canAccessFiles = null,
            onFileAccess = null,
            canUpload = null,
            onFinish = null,
            getCorsHeaders = null,
        } = limits;

        if (!app) throw new Error("Missing epxress app instance");
        if (!urlPath) throw new Error("Missing urlPath for endpoint");
        if (!uploadPath) throw new Error("Missing uploadPath for storing files");

        if (!getMaxMB) throw new Error("Missing getMaxMB");
        if (!getMaxFolderSizeMB) throw new Error("Missing getMaxFolderSizeMB");
        if (!getAllowedMimes) throw new Error("Missing getAllowedMimes");

        // create the upload folder if it doesnt exist yet
        if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, {recursive: true});

        const accessMw = canAccessFiles
            ? async (req, res, next) => {
                try {
                    const allowed = await canAccessFiles(req);
                    if (!allowed) return res.sendStatus(403);
                    next();
                } catch (e) {
                    return res.sendStatus(500);
                }
            }
            : (req, res, next) => next();

        const corsMw = getCorsHeaders
            ? async (req, res, next) => {
                try {
                    const headers = await getCorsHeaders(req);

                    for (const [key, value] of Object.entries(headers || {})) {
                        res.setHeader(key, value);
                    }

                    if (req.method === "OPTIONS")
                        return res.sendStatus(204);

                    next();
                } catch (e) {
                    return res.sendStatus(500);
                }
            }
            : (req, res, next) => next();

        // doesnt seem to work without it
        app.options(urlPath, corsMw);

        app.get(urlPath + "/*path", corsMw, accessMw, async (req, res) => {
            const relativePath = req.params.path.join("/");
            const filePath = path.join(uploadPath, relativePath);

            if (!this.isUploadPath(uploadPath, filePath))
                return res.sendStatus(403);

            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile())
                return res.sendStatus(404);

            const buf = fs.readFileSync(filePath);
            const type = await fileTypeFromBuffer(buf);

            res.setHeader("Content-Disposition", "inline");
            res.setHeader("Content-Type", type?.mime ?? "application/octet-stream");

            res.send(buf);

            if (onFileAccess) await onFileAccess(req);
        });

        app.get(urlPath + "/:id", corsMw, accessMw, async (req, res) => {
            const id = req.params.id;
            const file = fs.readdirSync(uploadPath).find(f => f === id || f.startsWith(id + "."));
            if (!file) return res.sendStatus(404);

            const filePath = path.join(uploadPath, file);
            const buf = fs.readFileSync(filePath);
            const type = await fileTypeFromBuffer(buf);

            res.setHeader("Content-Disposition", "inline");

            if (type?.mime) {
                res.setHeader("Content-Type", type.mime);
            } else {
                res.setHeader("Content-Type", "application/octet-stream");
            }

            res.send(buf);

            if (onFileAccess) await onFileAccess(req);
        });

        // corsMw is there so it can be uploaded from anywhere like the desktop client etc
        app.post(urlPath, corsMw, async (req, res) => {
            try {
                const filename = decodeURIComponent(req.headers["x-file-name"] ?? "");
                const chunkIndex = req.headers["x-chunk-index"];
                const totalChunks = req.headers["x-total-chunks"];
                const fileId = req.headers["x-file-id"];

                if (!filename)
                    return res.status(400).json({ok: false, error: "missing_filename"});

                if (chunkIndex === undefined)
                    return res.status(400).json({ok: false, error: "missing_chunkIndex"});

                if (totalChunks === undefined)
                    return res.status(400).json({ok: false, error: "missing_totalChunks"});

                if (!fileId)
                    return res.status(400).json({ok: false, error: "missing_fileId"});

                if (canUpload && !(await canUpload(req))) {
                    return res.status(403).json({ok: false});
                }

                const urlJoin = (...p) => p.join("/").replace(/\/+/g, "/");

                let headerBuf = Buffer.alloc(0);
                let fullBodyChunks = [];

                req.on("data", (chunk) => {
                    if (headerBuf.length < 5000) {
                        headerBuf = Buffer.concat([headerBuf, chunk]);
                        if (headerBuf.length > 5000) {
                            headerBuf = headerBuf.slice(0, 5000);
                        }
                    }
                    fullBodyChunks.push(chunk);
                });

                req.on("end", async () => {
                    try {
                        const fullBody = Buffer.concat(fullBodyChunks);
                        const clean = this.sanitizeFilename(filename);
                        const dir = getUploadPath ? await getUploadPath(req) : uploadPath;

                        // some checks lol
                        if (!dir)
                            return res.status(500).json({ok: false, error: "missing_upload_path"});

                        if (!this.isUploadPath(uploadPath, dir))
                            return res.status(403).json({ok: false, error: "invalid_upload_path"});

                        if (!/^[a-zA-Z0-9_-]{8,100}$/.test(fileId))
                            return res.status(400).json({ok: false, error: "invalid_fileId"});

                        if (!fs.existsSync(dir))
                            fs.mkdirSync(dir, {recursive: true});

                        // checking limits
                        const maxMB = await getMaxMB(req);
                        const maxBytes = Number(maxMB ?? 1) * 1024 * 1024;

                        if (chunkIndex == 0 &&
                            this.getFolderSize(dir) >= Number(await getMaxFolderSizeMB(req)) * 1024 * 1024)
                            return res.status(507).json({ok: false, error: "storage_full"});

                        const temp = path.join(dir, `${fileId}_${clean}.part`);
                        const meta = path.join(dir, `${fileId}.meta.json`);

                        if (!this.isUploadPath(uploadPath, temp) || !this.isUploadPath(uploadPath, meta))
                            return res.status(403).json({ok: false, error: "invalid_upload_path"});

                        // allowed file types like uploadFileTypes i think it was called in dcts
                        const mimeConfig = await getAllowedMimes(req);

                        if (chunkIndex == 0) {
                            let {mime} = (await fileTypeFromBuffer(headerBuf)) || {};

                            if (!mime) {
                                const ext = path.extname(filename).toLowerCase();
                                mime = mimeConfig.fallback[ext];
                            }

                            // mime not found or included = fuck off
                            const allowedMimes = [
                                ...mimeConfig.allowed,
                                ...Object.values(mimeConfig.fallback)
                            ];

                            if (!allowedMimes.includes(mime)) {
                                return res.status(415).json({
                                    ok: false,
                                    error: `mime_not_allowed ${mime}`
                                });
                            }

                            if (fs.existsSync(temp)) fs.unlinkSync(temp);
                            fs.writeFileSync(temp, Buffer.alloc(0));
                            fs.writeFileSync(meta, JSON.stringify({mime}));
                        }

                        // check file size heh
                        const current = fs.existsSync(temp) ? fs.statSync(temp).size : 0;
                        const next = current + fullBody.length;

                        // then check file size during upload
                        if (next > maxBytes)
                            return res.status(413).json({ok: false, error: "file_too_large"});

                        // append it to the file
                        fs.appendFileSync(temp, fullBody);

                        // then we will check for the chunks if its still only a part
                        // or finished
                        if (Number(chunkIndex) + 1 < Number(totalChunks))
                            return res.json({ok: true, part: true});

                        // then we will calculate the hash of it
                        const hash = this.getFileHash(temp);

                        // if there is already a meta file try to get the saved mime type
                        let mimeType = null;
                        if (fs.existsSync(meta)) {
                            mimeType = JSON.parse(fs.readFileSync(meta, "utf8")).mime;
                            fs.unlinkSync(meta);
                        }

                        // this is important for more control and to either keep the original filename
                        // or use the amazing file hash system
                        const keepFilename = typeof keepOriginalFilename === "function" ?
                            await keepOriginalFilename(req)
                            : false;

                        const ext = path.extname(clean).replace(".", "") || "bin";
                        const finalName = keepFilename === true ? clean : `${hash}.${ext}`;

                        const finalPath = path.join(dir, finalName);
                        const relativeFinalPath = path.relative(uploadPath, finalPath).replaceAll("\\", "/");

                        const existing = fs.readdirSync(dir).find(n => n.startsWith(hash));
                        if (existing) {
                            fs.unlinkSync(temp);
                            return res.json({ok: true, exists: true, path: urlJoin(urlPath, existing)});
                        }

                        if (!this.isUploadPath(uploadPath, finalPath))
                            return res.status(403).json({ok: false, error: "invalid_upload_path"});

                        fs.renameSync(temp, finalPath);

                        if (onFinish) {
                            await onFinish(req, {
                                hash,
                                mimeType,
                                ext,
                                finalName,
                                finalPath: path.join(dir, finalName)
                            });
                        }

                        return res.json({ok: true, exists: false, path: urlJoin(urlPath, relativeFinalPath)});

                    } catch (err) {
                        Logger.error("Upload Final Err", err);
                        return res.status(500).json({ok: false, error: "server_error"});
                    }
                });

            } catch (err) {
                Logger.error("Upload Error", err);
                return res.status(500).json({ok: false, error: "server_error"});
            }
        });
    }
}
