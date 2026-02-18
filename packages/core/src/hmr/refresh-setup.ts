/**
 * JavaScript code that must run BEFORE React DOM loads.
 * Creates __REACT_DEVTOOLS_GLOBAL_HOOK__ so React DOM injects its internals,
 * which React Refresh runtime needs to connect to the renderer.
 */
export const REFRESH_SETUP_CODE = `
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || {
  renderers: new Map(),
  supportsFiber: true,
  inject: function(injected) {
    var id = this.renderers.size;
    this.renderers.set(id, injected);
    return id;
  },
  onScheduleFiberRoot: function() {},
  onCommitFiberRoot: function() {},
  onCommitFiberUnmount: function() {}
};
`;
