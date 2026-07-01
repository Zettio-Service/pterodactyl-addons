# Changelog

## 2.0.0

- Reworked upload flow: dropped/picked folders are packed into a tar.gz in the browser (native
  `CompressionStream`, no libraries), uploaded as a single archive, extracted with `files/decompress`
  and the archive is deleted with `files/delete`, instead of creating folders and uploading files one by one.
- POST calls to the client API now send `X-XSRF-TOKEN` and `X-Requested-With`, decompress retries a few
  times in case Wings has not seen the freshly uploaded archive yet, and failures are logged to the console.
- Very large drops are split into several archives to stay under a safe upload size.
- Plain files dropped without any folder still upload directly, unarchived, same as before.
- Removed the review modal and the old top indicator; replaced with a single thin progress bar
  pinned to the bottom of the page, split into an upload stage and an extract stage, with the
  current upload speed shown on the left. Click the bar to cancel.
- The green bottom glow on success is unchanged.

## 1.0.0

- First release.
- Upload whole folders and several directories at once, no archiving.
- Action button sits next to the native Upload button and matches its style.
- Drag a folder anywhere on the file manager and the upload starts on drop.
- Parallel batched uploads with overall progress, speed and ETA.
- Top indicator with a border that fills in by stage.
- Cancel an upload and retry only the files that failed.
- The file list refreshes on its own when the upload finishes.
