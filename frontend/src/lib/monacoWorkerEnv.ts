import editorWorker from "monaco-editor/editor/editor.worker?worker";

// Monaco 要 self.MonacoEnvironment.getWorker 才拿得到编辑器 worker。
// Vite 的 `?worker` 把它打成独立 chunk，跟随前端产物（//go:embed）加载 —— 控制台
// 与桌面端一样不触网，CDN 面为零。
//
// monaco-editor 0.56 的 exports 映射 `"./*": "./esm/vs/*.js"` 已自带 esm/vs/ 前缀：
// 深导入必须写 monaco-editor/editor/editor.worker，带前缀会双写路径导致解析失败。
//
// 只读预览只需要 editor worker（文本模型 / 词法 / diff 计算）；TS/JSON/CSS/HTML
// 那些 language worker 只服务 IntelliSense，预览用不到，不打包。
// 本模块只被 monacoLoader 动态 import，组件与测试永不静态触碰。
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};
