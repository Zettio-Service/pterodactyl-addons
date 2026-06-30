<div class="row">
  <div class="col-xs-12">
    <div class="box">
      <div class="box-header with-border">
        <h3 class="box-title">Multi Upload</h3>
      </div>
      <div class="box-body">
        <p>
          Adds an <strong>Upload Folders</strong> action next to the native Upload button in the server file
          manager. Users can drop entire directory trees or pick a folder, and every file is sent to Wings
          through the regular client API while the folder structure is recreated for them. Nothing is archived
          first and no Wings changes are required.
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
          <li>Folders are created with <code>files/create-folder</code>, shallowest paths first.</li>
          <li>Files upload in parallel batches through a signed <code>files/upload</code> url with live progress.</li>
          <li>The current file manager directory is used as the destination root.</li>
          <li>Everything runs in the browser, so the addon survives panel and Wings updates.</li>
        </ul>
      </div>
    </div>
  </div>
</div>
