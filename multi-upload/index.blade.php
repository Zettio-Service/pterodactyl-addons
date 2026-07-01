<div class="row">
  <div class="col-xs-12">
    <div class="box">
      <div class="box-header with-border">
        <h3 class="box-title">Multi Upload</h3>
      </div>
      <div class="box-body">
        <p>
          Adds an <strong>Upload Folders</strong> action next to the native Upload button in the server file
          manager. Users can drop an entire directory tree or pick a folder: it is packed into a tar.gz in the
          browser, uploaded as a single archive, extracted by Wings and the archive is deleted automatically, keeping
          the folder structure intact. No Wings changes are required.
        </p>
        <p style="margin-bottom: 0;">
          There is nothing to configure here. The feature appears automatically on every
          <code>/server/&lt;id&gt;/files</code> page for users that may upload files. Made by Erik.
        </p>
      </div>
    </div>

    <div class="box">
      <div class="box-header with-border">
        <h3 class="box-title">How it works</h3>
      </div>
      <div class="box-body">
        <ul style="margin-bottom: 0; padding-left: 18px;">
          <li>Dropped or picked folders are packed into a tar.gz client-side (native <code>CompressionStream</code>, no libraries).</li>
          <li>Very large drops are split into several archives to stay under a safe request size.</li>
          <li>Each archive uploads through a signed <code>files/upload</code> url, then <code>files/decompress</code> extracts it and <code>files/delete</code> removes it.</li>
          <li>Plain files dropped without any folder still upload directly, unarchived.</li>
          <li>The current file manager directory is used as the destination root.</li>
          <li>Everything runs in the browser, so the addon survives panel and Wings updates.</li>
        </ul>
      </div>
    </div>
  </div>
</div>
