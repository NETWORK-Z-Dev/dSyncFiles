import crypto from "crypto";
import path from "path";
import fs from "fs";
import Logger from "@hackthedev/terminal-logger";
import {fileTypeFromBuffer} from "file-type";
import express from "express";
import crypto from "crypto";

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
            .normalize("NFD")                  // Normalize to decompose accented characters
            .replace(/[\u0300-\u036f]/g, '')   // Remove diacritical marks
            .replace(/[^a-zA-Z0-9._-]/g, '_')  // Replace non-alphanumeric chars with _
            .replace(/\s+/g, '_');             // Replace spaces with underscores
    }

    sha256(b) {
        return crypto.createHash("sha256").update(b).digest("hex");
    }

    getFileHash(path) {
        const finalBuf = fs.readFileSync(path);
        return this.sha256(finalBuf);
    }

    async registerFileUploadHandle({
                                       app = null,
                                       urlPath = null,
                                       uploadPath = null,
                                       limits = {}
                                   }) {

        const {
            getMaxMB = null,
            getMaxFolderSizeMB = null,
            getAllowedMimes = null,
            canAccessFiles = null
            canUpload = null,
            onFinish = null
        } = limits;

        if(!app) throw new Error("Missing epxress app instance");
        if(!urlPath) throw new Error("Missing urlPath for endpoint");
        if(!uploadPath) throw new Error("Missing uploadPath for storing files");

        if(!getMaxMB) throw new Error("Missing getMaxMB");
        if(!getMaxFolderSizeMB) throw new Error("Missing getMaxFolderSizeMB");
        if(!getAllowedMimes) throw new Error("Missing getAllowedMimes");

        // create the upload folder if it doesnt exist yet
        if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, {recursive: true})


        const accessMw = canAccessFiles
            ? canAccessFiles
            : (req, res, next) => next();

        app.get(urlPath + "/:id", accessMw, (req, res) => {
            const filePath = path.join(uploadPath, req.params.id);

            if (!fs.existsSync(filePath)) {
                return res.sendStatus(404);
            }

            res.sendFile(filePath);
        });


        app.post(urlPath, async (req, res) => {
            try {
                const {
                    filename, chunkIndex, totalChunks
                } = req.query;

                const fileId = crypto.randomUUID()

                // check if allowed to upload if set
                if (canUpload && !(await canUpload(req))) {
                    return res.status(403).json({ ok: false });
                }

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
                        const dir = uploadPath;

                        const maxBytes = (await getMaxMB(req) || 1) * 1024 * 1024; // default 1 mb

                        if (chunkIndex == 0 &&
                            this.getFolderSize(dir) >= Number(await getMaxFolderSizeMB(req)) * 1024 * 1024) return res.status(507).json({
                                                                                                                                         ok: false,
                                                                                                                                         error: "storage_full"
                                                                                                                                     });

                        const temp = path.join(dir, `${fileId}_${clean}`);

                        let allowedMimeTypes = await getAllowedMimes(req);
                        if (chunkIndex == 0) {
                            const {mime} = (await fileTypeFromBuffer(headerBuf)) || {};
                            if (!mime || !allowedMimeTypes.includes(mime)) return res.status(415).json({
                                                                                                           ok: false,
                                                                                                           error: "mime_not_allowed"
                                                                                                       });

                            fs.writeFileSync(temp, Buffer.alloc(0));
                        }

                        const current = fs.existsSync(temp) ? fs.statSync(temp).size : 0;
                        const next = current + fullBody.length;

                        if (next > maxBytes) return res.status(413).json({ok: false, error: "file_too_large"});

                        fs.appendFileSync(temp, fullBody);

                        if (Number(chunkIndex) + 1 < Number(totalChunks)) return res.json({ok: true, part: true});

                        const hash = this.getFileHash(temp)

                        const existing = fs.readdirSync(dir).find(n => n.startsWith(hash));
                        if (existing) {
                            fs.unlinkSync(temp);
                            return res.json({ok: true, exists: true, path: path.join(uploadPath, existing)});
                        }

                        const finalName = `${hash}`;
                        fs.renameSync(temp, path.join(dir, finalName));

                        if(onFinish) await onFinish(req);

                        return res.json({ok: true, exists: false, path: path.join(uploadPath, finalName)});

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
