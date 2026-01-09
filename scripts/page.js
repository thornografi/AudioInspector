// Page script - Runs in MAIN world, can access page variables

(function() {
  // Find extension URL from meta tag (CSP safe) or legacy window variable
  let baseUrl = window.__audioPipelineExtensionUrl;
  if (!baseUrl) {
    const meta = document.getElementById('audio-pipeline-extension-url');
    if (meta) {
      baseUrl = meta.getAttribute('content');
    }
  }

  if (baseUrl) {
    // Install early hooks FIRST (before any other code)
    const earlyHookUrl = new URL('src/core/utils/EarlyHook.js', baseUrl).href;
    import(earlyHookUrl).then(earlyHookModule => {
      earlyHookModule.installEarlyHooks();

      // THEN initialize PageInspector
      const entryPoint = new URL('src/page/PageInspector.js', baseUrl).href;
      return import(entryPoint);
    }).then(module => {
      module.autoRun();
    }).catch(err => {
      console.error('[Page] Failed to load new architecture:', err);
    });
  } else {
    console.error('[Page] Extension URL not found, cannot load new architecture.');
  }
})();
