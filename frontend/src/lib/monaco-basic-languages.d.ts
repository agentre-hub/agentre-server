// monaco-editor 0.56 的 basic-languages 入口没有随包发类型声明（它只有副作用：
// 注册全部纯词法语言）。这里给一个空的模块声明，让 `await import(...)` 的返回值
// 是 any 而不是编译错误 —— 我们本来也不用它的返回值。
//
// 与桌面端那份同名声明是**同一条构建面的补丁**，不是可共享的实现：它描述的是
// 这个宿主怎么打包 monaco，而共享包对 monaco 只有类型依赖、不装载它。
declare module "monaco-editor/basic-languages/monaco.contribution";
