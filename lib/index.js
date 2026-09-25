// dsh-relay-plugin 宿主半入口：转出 impl.js 的实现。
//
// ⚠️ 切勿在此加 `export { default } from './impl.js'`：loader 以
// `exports.default ?? exports` 取插件对象，且 runtime 只读 `plugin.Config`
// （vendor/loader → cordis registry）——default 若是裸 apply 函数，fn.Config
// 为 undefined，schema 整个丢失：行配置表单的 describe 跳过本条目（表单空白）、
// entry config 不经 schema 校验/默认值/volatile 包装（apply 收到裸 {} 或 null）。
// 函数式插件的正解就是纯具名导出：apply + Config（官方样板同形）。
//
// 之所以是薄壳：loader 的 import 缓存按模块 URL 命中，进程存活期间改
// 实现文件不换 URL 不生效（运行实例热更见 README「实现要点」）；
// 冷启动走本入口，与热路径同一份实现。
export * from './impl.js';
