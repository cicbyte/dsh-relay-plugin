// dsh-relay-plugin 宿主半入口：转出 impl.js 的实现。
//
// 之所以是薄壳：loader 的 import 缓存按模块 URL 命中，进程存活期间改
// 实现文件不换 URL 不生效（热激活走新包名马甲，见 README「热激活」）；
// 冷启动走本入口，与热路径同一份实现。
export * from './impl.js';
export { default } from './impl.js';
