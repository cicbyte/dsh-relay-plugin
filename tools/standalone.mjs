// 桌面桥独立运行入口（不经 dsh 插件宿主）：node tools/standalone.mjs
//
// 场景：e2e 联调 / 临时接入 / 宿主插件暂不可用时手动拉桥。
// 配置解析与插件内一致：$DSH_HOME/mobile-bridge.json + RELAY_* 环境变量覆盖。
// 首次配对：RELAY_PAIRING_CODE=XXXX-XXXX（管理台/环境视图生成 role=host）；
// 配对成功后设备凭据写回配置文件，此后走令牌重连。
import { MobileBridge, resolveConfig } from '../lib/bridge.js';

const logger = {
  info: (...a) => console.log('[bridge]', ...a),
  warn: (...a) => console.warn('[bridge][warn]', ...a),
  error: (...a) => console.error('[bridge][error]', ...a),
  debug: (...a) => process.env.BRIDGE_DEBUG && console.log('[bridge][debug]', ...a),
};

const config = resolveConfig(process.env.BRIDGE_CONFIG ? { configFile: process.env.BRIDGE_CONFIG } : {});
logger.info('启动独立桥', JSON.stringify({
  relayUrl: config.relayUrl,
  dshUrl: config.dshUrl,
  name: config.name,
  paired: Boolean(config.deviceId && config.token),
  hasPairingCode: Boolean(config.pairingCode),
}));

const bridge = new MobileBridge(config, logger);
bridge.start();

process.on('SIGINT', () => {
  logger.info('收到 SIGINT，关闭桥');
  bridge.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  bridge.close();
  process.exit(0);
});
