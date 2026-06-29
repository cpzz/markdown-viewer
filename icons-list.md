# 图标按钮清单

所有图标均为内联 SVG，风格统一为 [Lucide](https://lucide.dev) 线性图标。
统一参数：`viewBox="0 0 24 24"` + `fill="none"` + `stroke="currentColor"` + `stroke-width="2"` + `stroke-linecap="round"` + `stroke-linejoin="round"`。

## 工具栏按钮（16×16）

| 按钮 ID | 功能 | 图标（Lucide） | 状态说明 | 位置 |
|---------|------|---------------|---------|------|
| `btn-workspace` | 显示/隐藏工作区侧边栏 | [panel-left-close](https://lucide.dev/icons/panel-left-close) / [panel-left-open](https://lucide.dev/icons/panel-left-open) | 可见→close；隐藏→open | [main.ts#L2180](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2180) |
| `btn-open-file` | 打开文件/目录（下拉菜单触发） | [folder-open](https://lucide.dev/icons/folder-open) | 静态 | [main.ts#L2182](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2182) |
| `open-menu-file` | 打开文件（菜单项） | [file-plus](https://lucide.dev/icons/file-plus) | 静态 | [main.ts#L2184](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2184) |
| `open-menu-dir` | 打开目录（菜单项） | [folder-plus](https://lucide.dev/icons/folder-plus) | 静态 | [main.ts#L2185](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2185) |
| `btn-reopen-file` | 重新打开文件 | [refresh-ccw](https://lucide.dev/icons/refresh-ccw) | 静态 | [main.ts#L2188](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2188) |
| `btn-save-file` | 保存文件 | [save](https://lucide.dev/icons/save) | 静态 | [main.ts#L2189](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2189) |
| `btn-format-file` | 格式化文件 | [layers](https://lucide.dev/icons/layers) | 静态 | [main.ts#L2190](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2190) |
| `btn-toggle-source` | 切换源码面板显示 | [file](https://lucide.dev/icons/file) / [file-text](https://lucide.dev/icons/file-text) | 可见→file；隐藏→file-text | [main.ts#L2192](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2192) |
| `btn-toggle-preview` | 切换预览面板显示 | [eye-closed](https://lucide.dev/icons/eye-closed) / [eye](https://lucide.dev/icons/eye) | 可见→eye-closed；隐藏→eye | [main.ts#L2193](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2193) |
| `btn-settings` | 打开设置对话框 | [settings](https://lucide.dev/icons/settings) | 静态 | [main.ts#L2194](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2194) |
| `btn-lang` | 切换界面语言 | [globe](https://lucide.dev/icons/globe) | 静态 | [main.ts#L2195](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2195) |
| `btn-theme` | 切换深色/浅色主题 | [sun](https://lucide.dev/icons/sun) / [moon](https://lucide.dev/icons/moon) | 深色→sun；浅色→moon | [main.ts#L2196](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2196) |

## 查找/替换栏按钮（16×16）

| 按钮 ID | 功能 | 图标（Lucide） | 状态说明 | 位置 |
|---------|------|---------------|---------|------|
| `btn-find-prev` | 查找上一个 | [arrow-up](https://lucide.dev/icons/arrow-up) | 静态 | [main.ts#L2214](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2214) |
| `btn-find-next` | 查找下一个 | [arrow-down](https://lucide.dev/icons/arrow-down) | 静态 | [main.ts#L2215](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2215) |
| `btn-find-toggle-replace` | 展开/收起替换栏 | [chevron-down](https://lucide.dev/icons/chevron-down) / [chevron-up](https://lucide.dev/icons/chevron-up) | 收起→down；展开→up | [main.ts#L2218](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2218) |
| `btn-find-close` | 关闭查找栏 | [x](https://lucide.dev/icons/x) | 静态 | [main.ts#L2219](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2219) |
| `btn-replace-one` | 替换当前匹配项 | [replace](https://lucide.dev/icons/replace) | 静态 | [main.ts#L2226](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2226) |
| `btn-replace-all` | 替换所有匹配项 | [replace-all](https://lucide.dev/icons/replace-all) | 静态 | [main.ts#L2227](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2227) |
| `btn-escape-replace` | 切换正则转义模式 | [chevrons-left-right-ellipsis](https://lucide.dev/icons/chevrons-left-right-ellipsis) | 静态 | [main.ts#L2228](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2228) |

## 设置对话框（16×16）

| 按钮 ID | 功能 | 图标（Lucide） | 位置 |
|---------|------|---------------|------|
| `btn-settings-close` | 关闭设置对话框 | [x](https://lucide.dev/icons/x) | [main.ts#L2248](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2248) |

## 代码块（14×14）

| 元素 | 功能 | 图标（Lucide） | 位置 |
|------|------|---------------|------|
| `code-block__copy` | 复制代码块内容 | [copy](https://lucide.dev/icons/copy) | [main.ts#L293](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L293) |
| `code-block__copy`（完成态） | 复制成功提示 | [check](https://lucide.dev/icons/check) | [main.ts#L294](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L294) |

## 工作区树节点

| 元素 | 功能 | 图标（Lucide） | 尺寸 | 位置 |
|------|------|---------------|------|------|
| `workspace-expand-icon`（展开态） | 折叠目录节点 | [chevron-down](https://lucide.dev/icons/chevron-down) | 12×12 | [main.ts#L2365](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2365) |
| `workspace-expand-icon`（折叠态） | 展开目录节点 | [chevron-right](https://lucide.dev/icons/chevron-right) | 12×12 | [main.ts#L2366](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2366) |
| `workspace-item-icon`（文件） | 文件节点标识 | [file-minus](https://lucide.dev/icons/file-minus) | 16×16 | [main.ts#L2370](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2370) |
| `workspace-item-icon`（目录·展开） | 目录节点标识 | [folder-open](https://lucide.dev/icons/folder-open) | 16×16 | [main.ts#L2372](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2372) |
| `workspace-item-icon`（目录·折叠） | 目录节点标识 | [folder](https://lucide.dev/icons/folder) | 16×16 | [main.ts#L2373](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2373) |

## 说明

- 所有图标定义集中在 [main.ts#L2144-L2173](file:///d:/workspace/workspace/markdown-viewer/src/main.ts#L2144-L2173)（`svgIcon` helper + `ICON_*` 常量）。
- 可切换按钮（工作区/源码/预览/主题）的图标在点击处理函数中按当前状态动态切换 `innerHTML`。
- 原 `btn-open-file` 与 `btn-open-dir` 已合并为单个 `btn-open-file`（folder-open），点击弹出下拉菜单，内含 `open-menu-file` / `open-menu-dir` 两个菜单项。
- 原 `btn-ws-add-dir` 已移除（打开目录功能并入上述下拉菜单）。
- `btn-theme` 与 `btn-settings-close` 不再使用 Unicode 字符，均已改为内联 SVG。
