# Multi Upload

Blueprint extension for Pterodactyl by Erik.

Upload whole folders and several directories into the server file manager at once, keeping
their structure and without zipping anything first. Everything runs in the browser through the
standard client API, so Wings is never touched and the extension keeps working across panel and
Wings updates.

Repository: https://github.com/Zettio-Service/pterodactyl-addons (folder `multi-upload`).

## Features

- "Upload Folders" button next to the native Upload button, styled the same.
- Drag a folder anywhere on the file manager and the upload starts on drop.
- The full directory tree is recreated under the folder you are currently viewing.
- Top indicator with a border that fills in by stage, plus speed and ETA.
- Parallel batched uploads, cancel any time, retry only the files that failed.
- When the drop has no folders it falls back to a plain upload.
- The file list refreshes on its own and the bottom of the page lights up green when done.

## Requirements

- Pterodactyl panel with Blueprint (https://blueprint.zip/) installed.
- Blueprint target: `beta-2026-06`.

## Install

Run everything from the panel root (usually `/var/www/pterodactyl`).

### Option 1, download the prebuilt package

```bash
cd /var/www/pterodactyl
wget https://github.com/Zettio-Service/pterodactyl-addons/raw/main/multi-upload/multiupload.blueprint
blueprint -install multiupload
```

If you publish GitHub Releases, the latest build is also at:

```bash
wget https://github.com/Zettio-Service/pterodactyl-addons/releases/latest/download/multiupload.blueprint
blueprint -install multiupload
```

### Option 2, build from source

```bash
git clone https://github.com/Zettio-Service/pterodactyl-addons
cd pterodactyl-addons/multi-upload
bash build.sh
cp multiupload.blueprint /var/www/pterodactyl/
cd /var/www/pterodactyl
blueprint -install multiupload
```

After installing, open any server, go to the Files tab, and use the "Upload Folders" button or
just drop a folder onto the page. Do a hard refresh (Ctrl+F5) the first time so the browser picks
up the new assets.

## Update

Download the newer `multiupload.blueprint` the same way and run `blueprint -install multiupload`
again.

## Remove

```bash
blueprint -remove multiupload
```

## Develop

Place this folder as `.blueprint/dev/multiupload` inside your panel and run:

```bash
blueprint -build multiupload
```

## Layout

```
conf.yml             extension manifest
wrapper.blade.php    injects the css and js into the client dashboard
index.blade.php      admin panel info page
assets/icon.svg      admin panel icon
public/              served at /extensions/multiupload/
  multiupload.js     the uploader
  multiupload.css    styling
build.sh             builds multiupload.blueprint
```
