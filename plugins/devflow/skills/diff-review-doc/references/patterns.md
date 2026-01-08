# Common Code Patterns to Watch For

## Anti-Patterns

### 1. God Object / God Class
**识别标志：**
- 单个类/模块超过 500 行
- 类拥有过多职责（>5个不相关的方法）
- 被大量其他模块依赖

**风险：**
- 难以维护和测试
- 高耦合，牵一发动全身

### 2. Magic Numbers / Strings
**识别标志：**
```javascript
if (status === 1) { ... }
if (type === "USER_LOGIN") { ... }
setTimeout(callback, 5000)
```

**建议：**
- 使用命名常量
- 提取到配置文件

### 3. Deep Nesting
**识别标志：**
- 嵌套层级 >3
- 难以一眼看懂的条件判断

**建议：**
- 提前返回（early return）
- 提取子函数
- 使用策略模式

### 4. Copy-Paste Code
**识别标志：**
- 多处几乎相同的代码块
- 只有少量参数不同

**建议：**
- 提取公共函数
- 使用配置驱动

### 5. Shotgun Surgery
**识别标志：**
- 一个小改动需要修改多个文件
- 相关逻辑分散在各处

**风险：**
- 容易遗漏修改点
- 增加出错概率

## Security Patterns

### 1. SQL Injection
**危险模式：**
```javascript
// ❌ 危险
const query = `SELECT * FROM users WHERE id = ${userId}`
db.query(query)

// ❌ 危险
db.query("SELECT * FROM users WHERE name = '" + userName + "'")
```

**安全模式：**
```javascript
// ✅ 安全
db.query('SELECT * FROM users WHERE id = ?', [userId])

// ✅ 安全
db.query('SELECT * FROM users WHERE name = :name', { name: userName })
```

### 2. XSS (Cross-Site Scripting)
**危险模式：**
```javascript
// ❌ 危险
element.innerHTML = userInput

// ❌ 危险
eval(userInput)

// ❌ 危险 (React)
<div dangerouslySetInnerHTML={{__html: userInput}} />
```

**安全模式：**
```javascript
// ✅ 安全
element.textContent = userInput

// ✅ 安全 (React)
<div>{userInput}</div>

// ✅ 如需 HTML，使用 sanitizer
import DOMPurify from 'dompurify'
element.innerHTML = DOMPurify.sanitize(userInput)
```

### 3. Hardcoded Secrets
**危险模式：**
```javascript
// ❌ 危险
const API_KEY = "sk_live_abc123xyz"
const DB_PASSWORD = "admin123"
const JWT_SECRET = "my-secret-key"
```

**安全模式：**
```javascript
// ✅ 安全
const API_KEY = process.env.API_KEY
const DB_PASSWORD = process.env.DB_PASSWORD
const JWT_SECRET = process.env.JWT_SECRET
```

### 4. Insufficient Input Validation
**危险模式：**
```javascript
// ❌ 不足
app.post('/api/user', (req, res) => {
  const user = req.body
  db.insert(user)  // 直接插入未验证的数据
})
```

**安全模式：**
```javascript
// ✅ 完整验证
app.post('/api/user', (req, res) => {
  const schema = Joi.object({
    username: Joi.string().alphanum().min(3).max(30).required(),
    email: Joi.string().email().required(),
    age: Joi.number().integer().min(0).max(120)
  })

  const { error, value } = schema.validate(req.body)
  if (error) return res.status(400).json({ error: error.details })

  db.insert(value)
})
```

## Performance Patterns

### 1. N+1 Query Problem
**危险模式：**
```javascript
// ❌ N+1 查询
const users = await db.query('SELECT * FROM users')
for (const user of users) {
  user.posts = await db.query('SELECT * FROM posts WHERE user_id = ?', [user.id])
}
```

**优化模式：**
```javascript
// ✅ JOIN 或批量查询
const users = await db.query(`
  SELECT u.*, p.*
  FROM users u
  LEFT JOIN posts p ON u.id = p.user_id
`)

// ✅ 或使用 ORM 的 eager loading
const users = await User.findAll({ include: [Post] })
```

### 2. Inefficient Loops
**危险模式：**
```javascript
// ❌ 每次循环都查询
for (let i = 0; i < items.length; i++) {
  const config = getConfig()  // 重复获取
  processItem(items[i], config)
}

// ❌ 重复计算
for (let i = 0; i < array.length; i++) {  // length 每次都计算
  // ...
}
```

**优化模式：**
```javascript
// ✅ 提取到循环外
const config = getConfig()
for (const item of items) {
  processItem(item, config)
}

// ✅ 缓存长度
const len = array.length
for (let i = 0; i < len; i++) {
  // ...
}
```

### 3. Memory Leaks
**常见场景：**
```javascript
// ❌ 事件监听器未清理
useEffect(() => {
  window.addEventListener('resize', handleResize)
  // 缺少清理函数
}, [])

// ❌ 定时器未清理
useEffect(() => {
  const timer = setInterval(update, 1000)
  // 缺少清理
}, [])

// ❌ 闭包持有大对象引用
function createHandler() {
  const largeData = fetchLargeData()  // 大对象
  return () => {
    console.log(largeData.length)  // 闭包持有引用
  }
}
```

**正确模式：**
```javascript
// ✅ 清理事件监听器
useEffect(() => {
  window.addEventListener('resize', handleResize)
  return () => window.removeEventListener('resize', handleResize)
}, [])

// ✅ 清理定时器
useEffect(() => {
  const timer = setInterval(update, 1000)
  return () => clearInterval(timer)
}, [])

// ✅ 避免不必要的闭包引用
function createHandler() {
  const length = fetchLargeData().length  // 只保留需要的值
  return () => {
    console.log(length)
  }
}
```

### 4. Synchronous Heavy Operations
**危险模式：**
```javascript
// ❌ 阻塞主线程
const data = fs.readFileSync('large-file.json')
const result = JSON.parse(data)  // 大文件解析

// ❌ 同步大量计算
for (let i = 0; i < 1000000; i++) {
  heavyComputation(i)
}
```

**优化模式：**
```javascript
// ✅ 异步处理
const data = await fs.promises.readFile('large-file.json')
const result = JSON.parse(data)

// ✅ 分批处理
async function processInBatches(items, batchSize = 100) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize)
    await Promise.all(batch.map(item => heavyComputation(item)))
    await new Promise(resolve => setTimeout(resolve, 0))  // 让出主线程
  }
}
```

## Architecture Patterns

### 1. Circular Dependencies
**识别标志：**
```
A imports B
B imports C
C imports A  // 循环依赖
```

**风险：**
- 模块加载问题
- 难以测试和维护

**解决方案：**
- 提取共享接口
- 使用依赖注入
- 重新设计模块边界

### 2. Tight Coupling
**危险模式：**
```javascript
// ❌ 紧耦合
class OrderService {
  createOrder(data) {
    // 直接依赖具体实现
    const db = new MySQLDatabase()
    const payment = new StripePayment()
    const email = new SendGridEmail()

    db.insert(data)
    payment.charge(data.amount)
    email.send(data.email)
  }
}
```

**松耦合模式：**
```javascript
// ✅ 依赖注入
class OrderService {
  constructor(database, paymentService, emailService) {
    this.db = database
    this.payment = paymentService
    this.email = emailService
  }

  createOrder(data) {
    this.db.insert(data)
    this.payment.charge(data.amount)
    this.email.send(data.email)
  }
}
```

### 3. Missing Abstraction
**识别标志：**
- 直接操作底层实现细节
- 重复的数据转换逻辑
- 跨层级调用

**建议：**
- 引入适配器层
- 创建领域模型
- 使用仓储模式

### 4. Premature Optimization
**识别标志：**
- 复杂的优化代码但无性能问题
- 过度抽象但只有一个实现
- 复杂的缓存策略但数据很少变化

**原则：**
- 先保证正确性
- 测量后再优化
- 权衡复杂度与收益

## Reliability Patterns

### 1. Missing Error Handling
**危险模式：**
```javascript
// ❌ 无错误处理
async function fetchUserData(id) {
  const response = await fetch(`/api/users/${id}`)
  const data = await response.json()
  return data.user
}

// ❌ 吞掉错误
try {
  riskyOperation()
} catch (e) {
  // 空的 catch 块
}
```

**正确模式：**
```javascript
// ✅ 完整错误处理
async function fetchUserData(id) {
  try {
    const response = await fetch(`/api/users/${id}`)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = await response.json()

    if (!data.user) {
      throw new Error('User data not found in response')
    }

    return data.user
  } catch (error) {
    logger.error('Failed to fetch user data', { id, error })
    throw new UserFetchError(`Cannot fetch user ${id}`, { cause: error })
  }
}

// ✅ 有意义的错误处理
try {
  riskyOperation()
} catch (e) {
  logger.error('Operation failed', e)
  notifyAdmin(e)
  return fallbackValue()
}
```

### 2. Race Conditions
**危险模式：**
```javascript
// ❌ 竞态条件
let counter = 0

async function increment() {
  const current = counter
  await delay(100)
  counter = current + 1  // 可能被其他调用覆盖
}

// ❌ 状态不一致
if (this.isLoading) return
this.isLoading = true
await fetchData()  // 如果在这期间再次调用，状态会错乱
this.isLoading = false
```

**安全模式：**
```javascript
// ✅ 使用原子操作
let counter = 0
const lock = new Mutex()

async function increment() {
  await lock.acquire()
  try {
    counter++
  } finally {
    lock.release()
  }
}

// ✅ 防抖或请求取消
let currentRequest = null

async function fetchData() {
  // 取消之前的请求
  if (currentRequest) {
    currentRequest.cancel()
  }

  currentRequest = axios.get('/api/data', {
    cancelToken: new axios.CancelToken(c => {
      currentRequest.cancel = c
    })
  })

  const response = await currentRequest
  return response.data
}
```

### 3. Resource Leaks
**常见场景：**
- 数据库连接未关闭
- 文件句柄未释放
- 事件监听器未移除
- 定时器未清理

**检查点：**
- 每个 `open()` 是否有对应的 `close()`？
- 每个 `addEventListener()` 是否有对应的 `removeEventListener()`？
- 每个 `setInterval()` 是否有对应的 `clearInterval()`？
- 异常情况下资源是否正确释放？

## Testing Patterns

### 1. Flaky Tests
**识别标志：**
- 时而通过时而失败
- 依赖执行顺序
- 依赖外部状态或时间

**常见原因：**
- 异步操作未等待
- 共享状态污染
- 时间依赖（Date.now()）
- 网络请求依赖

### 2. Weak Assertions
**危险模式：**
```javascript
// ❌ 太宽泛
expect(result).toBeTruthy()
expect(array.length).toBeGreaterThan(0)

// ❌ 不检查重要属性
expect(user).toBeDefined()  // 但不检查具体内容
```

**强断言：**
```javascript
// ✅ 精确断言
expect(result).toBe(true)
expect(array).toHaveLength(3)

// ✅ 检查具体值
expect(user).toEqual({
  id: 1,
  name: 'John',
  email: 'john@example.com'
})
```

### 3. Missing Edge Cases
**应该测试的场景：**
- 空值（null, undefined, "", [], {}）
- 边界值（0, -1, MAX_INT）
- 特殊字符（emoji, HTML, SQL）
- 大数据量
- 并发情况
- 网络失败
- 权限不足

## Large File Changes

### 需要特别关注的大文件改动

**警示标志：**
- 单文件改动 >200 行
- 新文件 >500 行
- 核心业务逻辑文件的大规模改动

**重点检查：**
1. **改动原因** - 是否必要？是否可以分步进行？
2. **向后兼容** - 是否影响现有功能？
3. **测试覆盖** - 大改动是否有对应测试？
4. **文档更新** - API 变更是否更新文档？
5. **性能影响** - 是否引入性能问题？

**后端文件特别关注：**
- 数据库操作变更
- API 接口变更
- 权限逻辑变更
- 配置文件变更
- 第三方服务集成
