---
name: esm-migration
description: ESM 迁移助手 - 将 CommonJS 包改造为支持树摇优化的 ESM 包
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - TodoWrite
  - AskUserQuestion
---

# ESM Migration Skill

将 CommonJS 包改造为支持树摇优化的 ESM 包，同时保持向后兼容性。

## 触发条件

以下情况应建议或执行 ESM 迁移：

- 用户明确请求将包改造为 ESM 格式
- 用户提到"树摇优化"、"tree shaking"
- 用户要求优化包体积
- 单个常量文件过大 (>500 行) 且需要按需导入

## 改造流程

使用 TodoWrite 创建以下任务列表并逐步执行：

1. 确认用户需求（兼容性、拆分策略）
2. 分析代码结构，识别模块边界
3. 设计 package.json exports 配置
4. 实现代码改造
5. 更新测试文件
6. 验证构建产物
7. 清理旧文件
8. 运行 lint 检查

### 第一步：确认用户需求

使用 AskUserQuestion 工具确认两个关键问题：

**问题 1：兼容性策略**
- **双格式支持 (推荐)**: 同时提供 CJS 和 ESM，不破坏现有代码
- **仅 ESM**: 完全迁移，需同步更新所有依赖方

**问题 2：代码拆分策略**
- **拆分模块 (推荐)**: 按功能拆分到独立文件，树摇效果更好
- **保持单文件**: 仅改导出方式，改动最小但树摇效果有限

### 第二步：分析代码结构

1. 读取当前的 package.json 和主入口文件
2. 分析代码内容,识别不同功能模块
3. 根据功能相关性设计模块划分方案

**模块拆分原则:**
- 按功能域拆分,相关常量放在一起
- 每个模块独立可导入,支持按需加载
- 保持模块间低耦合,减少跨模块依赖
- 单个模块文件不超过 200 行 (建议)

**常见模块划分示例 (针对常量包):**
- `roles.js` - 角色和权限相关
- `events.js` - 事件常量
- `config.js` - 配置相关
- `constants.js` - 通用常量
- `types.js` - 类型定义
- `misc.js` - 杂项

### 第三步：设计 package.json

**双格式支持配置 (推荐):**

```json
{
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "exports": {
    ".": {
      "require": "./dist/index.cjs",
      "import": "./dist/index.mjs"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsdown",
    "prepublishOnly": "npm run build"
  },
  "devDependencies": {
    "tsdown": "^0.20.0"
  }
}
```

**仅 ESM 配置:**

```json
{
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": "./dist/index.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsdown"
  }
}
```

### 第四步：实现代码改造

#### 4.1 创建 src 目录结构

```bash
mkdir -p src
```

#### 4.2 拆分模块

将原始文件中的代码按功能拆分到不同的 ESM 模块文件:

```javascript
// src/roles.js
export const ROLES = /* #__PURE__ */ Object.freeze({
  ADMIN: 'admin',
  USER: 'user',
});

export const isAdmin = (role) => role === ROLES.ADMIN;
```

**关键点：**
- 使用 `export` 导出，不使用 `module.exports`
- 模块间导入使用 `.js` 扩展名
- 保持所有导出的函数/常量名称不变
- `Object.freeze()` 调用添加 `/* #__PURE__ */` 注释

#### 4.3 创建主入口文件

```javascript
// src/index.js
// 重新导出所有模块
export * from './roles.js';
export * from './events.js';
export * from './config.js';
// ...其他模块
```

**重要:** 主入口文件只做重新导出,保持 API 不变

#### 4.4 创建构建配置

创建 `tsdown.config.ts`:

```typescript
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.js'],
  format: ['esm', 'cjs'],  // 双格式
  clean: true,
  outDir: 'dist',
});
```

#### 4.5 创建 .gitignore

```
dist
node_modules
*.log
coverage
.turbo
```

### 第五步：更新测试文件

将测试文件从 CommonJS 改为 ESM:

**Before:**
```javascript
const constants = require('..');
```

**After:**
```javascript
import * as constants from '../src/index.js';
```

### 第六步：验证改造

#### 6.1 安装依赖并构建

```bash
bun add -D tsdown
bun run build
```

#### 6.2 验证构建产物

```bash
# 验证 CommonJS 导出
node -e "const c = require('./dist/index.cjs'); console.log('CJS:', Object.keys(c).slice(0, 5))"

# 验证 ESM 导出
node -e "import('./dist/index.mjs').then(c => console.log('ESM:', Object.keys(c).slice(0, 5)))"
```

#### 6.3 运行测试

```bash
bun run test
```

#### 6.4 运行 lint

```bash
bun run lint:fix
bun run lint
```

### 第七步：清理旧文件

```bash
# 备份原始文件
git mv index.js index.js.bak

# 或者直接删除 (确认无问题后)
rm index.js
```

### 第八步：验证集成

在项目根目录验证改造后的包能正常使用:

```bash
# 如果项目使用 turbo 构建
cd ../../
bun run turbo:dep

# 运行相关测试
bun run test
```

## 树摇优化进阶

### `/* #__PURE__ */` 注释

打包工具（Rollup/esbuild/webpack）在做树摇时，如果不确定某个表达式是否有副作用，会保守地保留它。`Object.freeze()`、`Object.assign()` 等函数调用虽然实际上是纯函数，但打包工具可能不知道这一点。

**问题示例：**

```javascript
// 打包工具认为这可能有副作用，即使没被使用也不敢删除
export const ROLES = Object.freeze({
  ADMIN: 'admin',
  USER: 'user',
});
```

**解决方案：使用 `/* #__PURE__ */` 注释**

```javascript
// 告诉打包工具：这是纯函数调用，如果没被使用可以安全删除
export const ROLES = /* #__PURE__ */ Object.freeze({
  ADMIN: 'admin',
  USER: 'user',
});
```

**适用场景：**

| 场景 | 需要 `/* #__PURE__ */` |
|------|------------------------|
| `Object.freeze({...})` | ✅ 是 |
| `Object.freeze([...])` | ✅ 是 |
| `Object.assign({}, ...)` | ✅ 是 |
| 纯对象字面量 `{...}` | ❌ 否 |
| 纯数组字面量 `[...]` | ❌ 否 |
| 字符串/数字常量 | ❌ 否 |

**注意事项：**

`/* #__PURE__ */` 只对函数调用有效，对以下情况无效：

```javascript
// ❌ 这些情况 #__PURE__ 无法解决

// 1. 展开运算符引用其他变量
export const SERVER_ROLES = /* #__PURE__ */ Object.freeze({
  ...ROLES,  // ← 展开 ROLES 会导致 ROLES 被保留
});

// 2. 数组/对象中引用其他变量的属性
export const BLOCKLET_ROLES = [
  SERVER_ROLES.BLOCKLET_OWNER,  // ← 属性访问是副作用
];

// 3. 计算属性名引用变量
export const GRANTS = /* #__PURE__ */ Object.freeze({
  [SERVER_ROLES.ADMIN]: [...],  // ← 计算属性名会立即求值
});
```

**彻底解决方案：内联字面量值**

```javascript
// ✅ 正确：完全独立，无运行时依赖
export const ROLES = /* #__PURE__ */ Object.freeze({
  OWNER: 'owner',
  ADMIN: 'admin',
});

export const SERVER_ROLES = /* #__PURE__ */ Object.freeze({
  OWNER: 'owner',      // 直接写值，不用 ...ROLES
  ADMIN: 'admin',
  CI: 'ci',
});

export const BLOCKLET_ROLES = [
  'blocklet-owner',    // 直接写值，不用 SERVER_ROLES.xxx
  'blocklet-admin',
];
```

**ESLint 格式要求：**

某些 ESLint 配置要求注释前后有空格：

```javascript
// ❌ 可能报错
export const ROLES = /*#__PURE__*/ Object.freeze({...});

// ✅ 推荐格式
export const ROLES = /* #__PURE__ */ Object.freeze({...});
```

### 模块级全局变量优化

模块级别的全局变量和立即执行的代码会产生副作用，阻止打包工具进行有效的树摇。

**问题模式 1：模块级别立即实例化**

```javascript
// ❌ 问题：导入时立即创建实例，产生副作用
import QuickLRU from 'quick-lru';

const blockletCache = new QuickLRU({ maxSize: 30, maxAge: 60 * 1000 });

export class BlockletService {
  getBlocklet(baseUrl) {
    if (blockletCache.has(baseUrl)) {
      return blockletCache.get(baseUrl);
    }
    // ...
  }
}
```

**解决方案：使用懒加载 getter 函数**

```javascript
// ✅ 正确：延迟到实际使用时才创建实例
import QuickLRU from 'quick-lru';

let blockletCache: QuickLRU<string, Blocklet> | undefined;

function getBlockletCache(): QuickLRU<string, Blocklet> {
  if (!blockletCache) {
    blockletCache = new QuickLRU<string, Blocklet>({ maxSize: 30, maxAge: 60 * 1000 });
  }
  return blockletCache;
}

export class BlockletService {
  getBlocklet(baseUrl) {
    const cache = getBlockletCache();
    if (cache.has(baseUrl)) {
      return cache.get(baseUrl);
    }
    // ...
  }
}
```

**问题模式 2：模块级别访问全局对象**

```javascript
// ❌ 问题：导入时立即访问 window，产生副作用
const cacheTtl = window?.blocklet?.settings?.session?.cacheTtl;
let csrfTokenCache;

export function createAxios() {
  if (!csrfTokenCache) {
    csrfTokenCache = new Keyv({
      ttl: isNumber(cacheTtl) ? cacheTtl * 1000 : 1000 * 60 * 60,
    });
  }
  // ...
}
```

**解决方案：将全局对象访问移入函数内部**

```javascript
// ✅ 正确：window 访问延迟到函数调用时
let csrfTokenCache: Keyv | undefined;

function getCsrfTokenCache(): Keyv {
  if (!csrfTokenCache) {
    const cacheTtl = window?.blocklet?.settings?.session?.cacheTtl;
    csrfTokenCache = new Keyv({
      ttl: isNumber(cacheTtl) ? cacheTtl * 1000 : 1000 * 60 * 60,
    });
  }
  return csrfTokenCache;
}

export function createAxios() {
  const cache = getCsrfTokenCache();
  // ...
}
```

**需要优化的常见模式：**

| 模式 | 问题 | 解决方案 |
|------|------|----------|
| `const cache = new Map()` | 立即创建实例 | 使用 getter 函数懒加载 |
| `const cache = new QuickLRU({...})` | 立即创建实例 | 使用 getter 函数懒加载 |
| `const config = window.xxx` | 立即访问全局对象 | 移入函数内部 |
| `let state; ... state = xxx` | 模块级可变状态 | 封装到 getter 函数 |

**检查命令：**

```bash
# 查找模块级 let/var 声明
grep -rn "^let \|^var " src/

# 查找模块级 new 实例化
grep -rn "^const .* = new " src/

# 查找模块级 window 访问
grep -rn "^const .* = window" src/
```

**优化效果：**

- 如果模块未被使用，打包工具可以安全移除整个模块
- 消除导入时的副作用，提升应用启动性能
- 代码风格统一，易于维护

## 常见问题处理

### 问题 1：循环依赖

如果模块间存在循环依赖,重新设计模块边界:

- 将共享的类型/常量提取到独立模块
- 调整导入顺序
- 考虑合并高度耦合的模块

### 问题 2：动态导入

CommonJS 的 `require()` 动态导入需要改为:

```javascript
// Before
const mod = require(dynamicPath);

// After
const mod = await import(dynamicPath);
```

### 问题 3：__dirname 和 __filename

ESM 中需要替代方案:

```javascript
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
```

### 问题 4：构建失败

常见原因:
- 文件扩展名缺失 (ESM 必须包含 `.js`)
- 导入路径错误
- 语法错误

解决方法:
```bash
# 清理后重新构建
rm -rf dist
bun run build
```

## 检查清单

改造完成前，确认以下事项：

**配置检查：**
- [ ] package.json 配置正确 (type, main, module, exports)
- [ ] 构建配置文件存在 (tsdown.config.ts)
- [ ] .gitignore 包含 dist 目录

**代码检查：**
- [ ] 源代码使用 ESM 语法 (export/import)
- [ ] 主入口重新导出所有模块
- [ ] 导出的 API 保持不变（名称和签名）
- [ ] 测试文件已更新为 ESM

**树摇优化检查：**
- [ ] `Object.freeze()` 调用添加 `/* #__PURE__ */` 注释
- [ ] 模块级全局变量已改为懒加载模式
- [ ] 无模块级 `window` 访问（已移入函数内部）

**验证检查：**
- [ ] 构建成功 (`bun run build`)
- [ ] CommonJS 导出验证通过
- [ ] ESM 导出验证通过
- [ ] 测试通过 (`bun run test`)
- [ ] Lint 检查通过 (`bun run lint`)

**清理检查：**
- [ ] 旧文件已清理或备份
- [ ] 无用依赖已移除

## 注意事项

1. **向后兼容优先**: 推荐双格式支持，避免破坏现有项目
2. **逐步迁移**: 多包项目建议一次迁移一个
3. **充分测试**: 改造后必须运行完整测试套件

## 参考资料

- [ES Modules 规范](https://nodejs.org/api/esm.html)
- [package.json exports 字段](https://nodejs.org/api/packages.html#exports)
- [tsdown 文档](https://tsdown.dev)
- [树摇优化原理](https://developer.mozilla.org/en-US/docs/Glossary/Tree_shaking)
