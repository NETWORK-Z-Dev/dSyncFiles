# dSyncFiles

As another member of the dSync Concept, its job is to handle file uploads and access to them via highly dynamic parameters. The idea is to make it as flexible as possible and easy to maintain so it can be used in multiple projects.

------

## Basics

```js
import express from "express";
import dSyncFiles from "@hackthedev/dsync-files";

const app = express();
const files = new dSyncFiles();
```

------

## Registering Handles

These handles are specifically designed to work with express and are highly dynamic, which allows you to implement all sorts of systems around it.

```js
files.registerFileUploadHandle({
    app,
    urlPath: "/api/upload",
    uploadPath: "./uploads",
    limits: {
        keepOriginalFilename: async (req) => {
            // used to toggle if uploaded files should be 
            // renamed or not.
            //
            // If false, files will be renamed to their file hash.
            // If true, files will keep their original name and extension.
            return false;
        },
        
        getUploadPath: async (req) => {
            // allows you to handle different type of uploads depending on your goal.
            // e.g. profile pictures are stored on /storage/profiles,
            // mimes and files on /storage/files, ...
            // 
            // if you dont need this you can remove this entire block.
            // [!] Returning 'null' will make any upload fail.
            return "./uploads"
        },
        
        getMaxMB: async (req) => {
            if (!req.user) return 0; // cant upload without account
            
            // get user account info, for example a plan or similar.
            // simplified here with req.user.plan for the sake of the example.
            if (req.user.plan === "pro") return 100; // 100 mb upload limit
            return 10 // default user limit without plan
        },

        getMaxFolderSizeMB: async (req) => {
            // the max. folder size of the uploadPath folder. uploads will
            // fail once reached.
            return 1024; // 1 GB
        },

        getAllowedMimes: async (req) => {
            // the type of media that can be uploaded
            // 'allowed' is file content based whereas 'fallback'
            // is purely based on the file extension.
            return {
                allowed: [
                    "image/png",
                    "image/jpeg",
                    "application/pdf",
                    "application/json",
                    "text/javascript",
                    "text/html",
                    "text/css",
                    "text/plain",
                    "text/markdown",
                ],

                fallback: {
                    ".json": "application/json",
                    ".js": "text/javascript",
                    ".mjs": "text/javascript",
                    ".cjs": "text/javascript",
                    ".md": "text/markdown",
                    ".txt": "text/plain",
                    ".html": "text/html",
                    ".css": "text/css",
                    ".sh": "text/bash",
                }
            };
        },

        canUpload: async (req) => {
            // optional, must return a boolean.
            // in this example, users that arent signed in cant upload.
            // you could extend this for checking if a user is banned etc..
            return !!req.user;
        },

        canAccessFiles: (req, res, next) => {
            // optional, default will always allow access.
            // you could implement some sort of file verification feature or 
            // paywall content uploaded by creators.
            if (!req.user) return false;
            return true
        },
        
        onFileAccess: async (req) => {
                let fileName = req.params.id;            
            	// you can make a view system or add a rate limit 
            },

        onFinish: async (req) => {
            // optional.
            Logger.info("Upload finished", req.user?.id);
        }
    }
});
```

