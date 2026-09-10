# 安装示例

三种安装方式，任选其一。适用于 DSH `0.1.0-rc.7` 及同 API 的构建；其他版本见
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 方式 A：npm 安装（推荐，免构建授权）

```powershell
# 1. 在 profile 目录（如 ~/.dsh/profiles/web）安装
pnpm add @frog755/dsh-client-auto-retry

# 2. 编辑该目录的 package.json，把包加入 dsh.profile.bundles：
#    "dependencies": { "@frog755/dsh-client-auto-retry": "^0.4.0" }
#    "dsh": { "profile": { "bundles": [ ..., "@frog755/dsh-client-auto-retry" ] } }

# 3. 安装并重启
pnpm install
```

重启 DSH（Host 侧插件进程内只加载一次），再刷新浏览器页面。

## 方式 B：从 GitHub 安装

```powershell
pnpm add "github:Frog755/dsh-client-auto-retry"
```

同样需要把包加入 `dsh.profile.bundles` 并重启。

## 方式 C：本地 link 开发调试

```jsonc
{
  "dependencies": {
    "@frog755/dsh-client-auto-retry": "link:C:/Users/frog/.dsh/projects/dsh-client-auto-retry"
  }
}
```

Client 侧改动刷新页面即生效；Host 侧 `lib/index.js` 改动需重启 DSH。

## 验证是否生效

1. 打开浏览器 DevTools 控制台，应看到 `[auto-retry] 尝试连接 mux, 第 1 次` 日志。
2. 设置 → 通用 → **断联自动重试** 卡片应出现（含 8 个配置项）。
3. 在会话中触发一次中断（如断网或 provider 报错），宽限期后应自动发送「继续」。
