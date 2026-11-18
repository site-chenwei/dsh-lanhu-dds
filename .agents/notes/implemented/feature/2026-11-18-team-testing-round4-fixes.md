# Agent Note: 团队测试第四轮——契约误判与出码误导类缺陷修复

Status: implemented

## Problem

第四轮团队测试（四代理并行 + lead 亲证）在五张真实画布上定位出三类跨文件缺陷：

1. **出码误导（P0/P1）**：`tokens.css` 是假产物——两画布逐字节相同，`--color-text-primary: #1a1a1a` 是 render-html.mjs 硬编码，本套设计稿主色 `rgba(36,36,36)` 等全缺席；`orders` 屏 1–4 的 DDS 树序 ≠ 视觉序（视觉主体子树排在最后、`↑gap:412` 被 `box-43` 盖住），照 SKILL §6 按树写文档流必错乱，规格表零提示；`invoice` 屏 1↔2 变体差异表把 `box-1`（弹层根）错配到 `box-6`（表单容器），配对差异（620→721、334→435）整段缺失。
2. **契约误判（P1）**：`describeError` 把 URL 查询串里的 `version_id=10089`+`HTTP 500` 误判成 Cookie 过期；`scale:0` 生成全 NaN 规格表且表头称「可直接写进代码」；5 种接口异常文本全部落进 fallback 并叠加 Cookie 噪音提示。
3. **流程一致性（P2/P3）**：`screens.json` 落盘口径与 screens 工具不同（15/28 屏 texts 不一致）；strays 只扫根目录漏报子目录污染；`prune days:0` 全删；sessionKey 清洗撞名（`.a`≡`a`）；plan 屏序被重排；out 改名留孤儿产物；文案内层 ASCII 双引号未转义破坏树行解析。

## Decision

按「源头修一处、产物自洽」的原则分散修复，关键取舍如下：

- **树序提示做检测而非重排**：spec.mjs 新增 `overlapFacts`（兄弟矩形交叠 ≥ 小者面积 1/4 且有一侧是容器 → 层叠）与 `gapCovered`（`↑gap ≥ 100px` 区间被树序更晚节点盖住 ≥ 50% → 非留白，区间合并后算覆盖率），命中时在 readingNotes 顶部输出决策指引（按 `@y/@x` 重排、背景层当 background、蒙层绝对定位）。**不改 compile.mjs 重排树**——树序是 DDS 导出事实，重排会破坏 `name` 与图层的对应关系（doctor closeout、人工对照都要用），提示 + 指引让决策程序自己处理视觉关系。
- **双叶子交叠单独分类为「同行拆分」**：首轮全量跑 28 屏发现 `text-39 ¥`+`text-40 21,965.00`、`text-14 张三丰`+`text-15 ｜` 这类**两个叶子**的同矩形兄弟其实是 DDS 把一行内多个 run 拆开（货币符+数字、不同色高亮、小图标+文字），「画在之上→绝对定位」的建议会把模型带错方向。真层叠至少有一侧是容器，按 `kids.length` 分流到两条不同的提示。
- **variants 第 0 轮按「同型同深同名同父名」配对**：弹层整体加高/下移时签名（h 桶）与近邻（y≤12）都配不上，但名字与层级不变。护栏取 `|Δx|≤24 && |Δw|≤24 &&（|Δy|≤24 或 |Δbottom|≤24）`——真变体的移动要么顶部锚定、要么吸底加高，两头都漂的多半是独立绘制的两屏（address 空态/有数据），不配对是正确行为。已配节点作为 `alsoMatched` 回传，防止被误报「仅在某屏」。
- **describeError 先摘 URL 再匹配**：cookie 词表对「去 URL 的正文」匹配（getJson 报错形态是 `${url} → HTTP ${status}`，URL 里的 version_id 会先撞词表）；internal/network 词表对「去反引号的正文」匹配（Node 解构报错带反引号）。新增「形状异常」分支（缺 result / 无 data_resource_url），network 分支增补 `HTTP 404|Unexpected end of JSON|下载失败|下载返回空内容`。screens 工具 fallback hint 不再预判 Cookie。
- **参数校验全部前置到网络请求之前**：`out`（validateOutName）、`scale`（正有限数）、`designWidth`（正整数）在 `parseLanhuUrl` 后立即校验；plan 的 screens/keep/drop/file 类型收紧（挡 `[['']]`/`[true]` 静默强转）。测试驱动里假 cookie + `scale:0` 若还能拿到网络错误，就说明校验没前置。
- **撞名与孤儿**：`existingMeta.imageId ≠ 当前 imageId 且 !clean` → throw（out 目录已属于另一画布）；plans.json 提前读，`prev.outDir ≠ 新 outDir 且存在` → 警告「上一份产物还在 …」。**不给自动清理**——产物目录删除是不可逆动作，用户可能还要旧产物比对。
- **screens.json 换 digest 口径**：与 screens 工具同源（`digestScreens` 全屏跑一遍，未进 plan 的屏补一次纯内存编译），texts/popup/empty 完全一致；descs 口径（含壳层标题、8 条上限）废弃。
- **strays 递归**：文件名模式全项目扫（深度 ≤ 5、跳 node_modules/.git/dist/build/coverage、上限 20 条）；目录模式仍只扫根级（子目录里恰好叫 `tmp/` 的业务目录有假阳性风险）。
- **tokens 真实化**：collectTokens 按属性正则提色（rgba 全收）、textColors 单独统计；`--color-text-primary` 填真实高频文本色（无则省略行——compile.mjs 让缺色文本引用该变量，故不能彻底删除）；report.md 增「高频色值与字体」节给模型直接证据。
- 其余：sessionKey 清洗后 ≠ 原值则尾缀哈希 4 位；`prune days<1` 拒绝；行高提示多档分档列举 + 「扣减别取整」；文案内层双引号转义；图例 `bd` 改 `border:` 系；report @2x 行注明「指切图倍率；screen-N.png 是 1x 设计像素」、参考图三态、unplannedAdvice 进 build 返回体；doctor closeout canvases 补 `outDir`；SKILL.md 补 4 处口径（短 AGENTS.md 识别不到、树序/同行拆分/负偏移提示、图标占位尺寸按节点 `@w×h` 而非图档 48×48、rects.json 弹层屏 idx0 全屏底图跳过）。

## Alternatives considered

- **compile.mjs 里按视觉序重排子节点**：否。树序承载 DDS 图层语义（与蓝湖面板一致、`name` 稳定），重排后 doctor/人工对照断裂；且「谁压谁」的 z 序只有层叠列表能表达，排序会丢信息。提示 + 决策指引以 +4 行产物文本的成本解决。
- **near() 放宽 y 阈值到 101px 治 variants 错配**：否。invoice 的正确配对 y 差 101，但放宽全局 near 会把上下滑动的无关元素也配上，错配面扩大；第 0 轮同名配对 + 护栏是窄路径，只对「复制母版」这个 DDS 惯例开口。
- **out 撞名时自动清空旧画布产物（clean 隐含）**：否。产物目录是用户可能还要的交付物，静默删除不可逆；throw 让用户显式选换名或 clean。
- **strays 目录模式也递归**：否。子目录 `tmp/` 常是业务目录（构建缓存等），递归会大量误报；文件名模式（dump/probe/screen-N.spec 等）指纹明确，递归安全。
- **fs 口径并入 network 词表统一提示**：保留分开。磁盘错误（EPERM/ENOENT）的处置（换目录/清空间）与网络错误（重试）完全不同，合并会把模型引向重试死循环。

## Consequences

- **代价**：spec.md 头部新增提示使部分屏产物行数 +2~5；`digestScreens` 对未进 plan 的屏多一次纯内存编译（无网络、无切图，实测全流程无感知变慢）；variants 第 0 轮依赖 `nameOf` 的「复制屏同名」惯例，若蓝湖改导出规则需重估护栏。
- **收益**：五画布 28 屏产物口径自洽——screens.json 与 screens 工具逐屏 texts 一致；tokens.css 反映真实高频色（orders 主色 rgba(36,36,36)×68 进变量）；invoice 1↔2 差异表配对修复（`box-1/box-1` h:620→721、`box-6/box-6` h:334→435）；orders s1 的树序陷阱与 gap 假留白都有行内指引；26 项纯逻辑断言 + 10 项功能断言 + 幂等重跑 251 文件逐字节一致。
- **残留**：describeError 词表仍是字符串匹配，新的接口异常形态仍会落 fallback（fallback hint 已改为「把 error 原文告诉用户」不再瞎指方向）；变体屏「同视觉模式不同树形」（orders s0 列内标签 vs s1 行内标签）是设计稿本身的表达差异，规格表已给同行拆分提示，不再做结构归一。
