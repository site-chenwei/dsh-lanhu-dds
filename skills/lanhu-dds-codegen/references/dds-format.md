# DDS 布局树字段手册

逆向自蓝湖 DDS（`store_schema_revise` → `data_resource_url`）实测数据，覆盖 5 屏订单页、10 屏首页、8 屏地址管理三类画布。
凡是标「**坑**」的，都是不处理就必然出错的地方。

## 1. 节点结构

```jsonc
{
  "style": {...},            // 根节点的 style，子节点一般在 props.style
  "rowDims": { "left": 120, "top": 540, "width": 750, "height": 1881 },
  "eleName": "Block_Frame2275_80319",
  "id": "4608:19879",        // 真节点=Figma id；合成节点=row_120_120_520_220_882338
  "layerId": "4608:19879",   // 只有真节点有
  "type": "lanhupage|lanhublock|lanhutext|lanhuimage",
  "data": { "value": "..." },// 文本=文案；图片=URL
  "uiType": "ImageText|TextGroup|...",
  "uiTypeProb": 0.93,
  "designType": "...",
  "isddsAdaptive": true,
  "alignJustify": { "justifyContent": "space-between" },
  "componentName": "...",
  "props": { "style": {...}, "fontFamily": "..." },
  "children": [...]
}
```

### 1.1 `type` 只有四种

| type | 含义 | 注意 |
|---|---|---|
| `lanhupage` | 页面根 | 一次编译只取它下面**一屏**子树 |
| `lanhublock` | 容器/装饰块 | 可能带背景图、边框、圆角；没有文案 |
| `lanhutext` | 文本 | `data.value` 是文案，**含 HTML 实体** |
| `lanhuimage` | 图片 | `data.value` 是切图 URL |

### 1.2 合成节点（**坑**）

DDS 会自己造一批包装节点来表达 flex 布局，它们的 `id` 形如：

```
row_120_120_520_220_882338
col__444_23482
rect_168_930_604_149_846000
row_rect_ImageTextFrame1912053779_1_89168
```

判据：`/^(row|col|rect)_/` 且无 `layerId`。它们：
- 没有对应的 Figma 源，`eleName` 也无意义；
- 数量大、`id` 会重复，**不能拿来当 React key 或 DOM id**；
- 但它们是真实的布局层级，**不能丢**——丢了父子关系，绝对定位就会双倍叠加。

## 2. `rowDims`：画布绝对坐标（**最重要的一个字段**）

- 单位是**设备像素**，与参考图同尺度。根节点 `rowDims` 就是整张画布的像素尺寸（首页 9382×3254，订单页 4310×2594）。
- 父节点常与它的首个子节点**共享同一 rect**（子填满父）。直接按父子各自写 `position:absolute` 会叠加成双倍偏移。
- 正确做法：`子.left = 子.x − 父.x`，`子.top = 子.y − 父.y`；父级保留 `overflow:hidden` 才等价于设计稿的裁剪语义。

## 3. 缩放比与输出单位

设计稿是 @2x / @3x 的 iOS 稿，`rowDims` 全是设备像素。**逻辑宽几乎总是 375**：

```
scale = 屏宽(设备px) / 375      // 750 → 2x，1125 → 3x
```

但**输出默认保留设计稿 px（不除 scale）**：蓝湖原型按 750 宽设计，项目在构建期用 `postcss-px-to-rem`（`rootValue: 75`）统一换成 rem，所以 `rowDims` 上的数值原样落到代码里就是对的，除 2 反而错。

- 默认 `--unit design`：产物所有数值 = `rowDims` 原值，单位 px。
- `--unit css`：产物所有数值 = `rowDims / scale`，折到 375 逻辑宽（1x 项目或不用 px→rem 的项目用）。

`scale` 在默认模式下只用于两件事：识别屏（750 宽）和报告里标注稿子倍率，**不参与数值换算**。

`meta` 里的 `scale_metadata` 是**扁平点号键**（`{"meta.device":"iOS @2x","meta.sliceScale":2}`），不是嵌套对象，别按嵌套取。
`project/image` 返回的 `width/height` 是**封面缩略图**尺寸，不是画布尺寸（订单页返回 1077.5×648.5，真实画布 4310×2594）。**画布尺寸只信根节点 rowDims。**

## 4. 屏识别

一张设计大板横排 N 台手机。判据（设备像素域）：矩形窄而高、宽 ∈ [320,1800]、高 ∈ [450,6500]、至少 1 个子节点；取深度最小的那批，再按宽度取众数分组。左上角常有一条「标题贴片」（如 `row_120_120_520_220`，蓝底圆角，文案是设计名），它是屏的兄弟节点，不属于任何一屏，别当页面内容。

## 5. `props.style` 里的 CSS

真值直接是 CSS 键值。**实测口径：全项目 11 张设计图里 10 张有 DDS，共 4837 个节点**（grep 的是整棵树的键名，不是字符串值）：

| key | 命中 | 备注 |
|---|---|---|
| `width` `height` | 4837（100%） | 设备像素 |
| `marginTop` / `marginLeft` | 4210 / 3852 | 设备像素；abs 模式下应丢弃 |
| `fontSize` `fontFamily` `fontWeight` `textAlign` | 1924 | 只在文本节点上 |
| `color` | 1836 | **缺失率约 5%，必须回落** |
| `borderRadius` | 1383 | 字符串常带 `px`（`"36px"`、`"100px"`） |
| `backgroundColor` | 1149 | 纯色块 |
| `display` + `flexDirection` | 786 / 590 | 有 flex 语义就能还原语义布局 |
| `justifyContent` | 762 | space-between 最常见 |
| `border` + `borderWidth` | 271 + 271 | 成对出现；`borderWidth` 单独出现时没有颜色 |
| `background` + `backgroundSize` | 188 | 要么 `url("https://...")`，要么整串 `linear-gradient(...)`，**角度与色标齐全** |
| `backgroundImage` | 82 | 多为 `url(...)` |
| `letterSpacing` | 203 | 设备像素 |
| **`boxShadow`** | **5** | 合法 CSS：`0px 4px 40px 0px rgba(0,0,0,0.130000)` |
| `textShadow` / `filter` / `blur` | **0** | 除 boxShadow 外没有任何光影字段 |
| `position:absolute` | 10 | 绝大部分布局靠 flex |

> **阴影有，但别忘单位**：`0px 4px 40px` 是设备像素，@2x 下必须变成 `0px 2px 20px`，否则大一倍。编译器对 `boxShadow/textShadow/border/outline` 逐个 `px` 折算。
> **渐变不用猜**：`background` 已是合法 CSS，连 `WebkitBackgroundClip:text` + `WebkitTextFillColor:transparent` 的渐变文字都成对给全。
> **真正没有的**：`textShadow`、`filter`、模糊类效果、响应式约束、交互态。

### 5.1 非法/非常规值（**坑**）

必须归一，否则 CSS 静默失效：

| 出现值 | 应为 |
|---|---|
| `justifyContent: "flex-center"` | `center` |
| `alignItems: "flex-center"` | `center` |
| `textAlign: "justified"` | `justify` |
| `textAlign: "start" / "end"` | `left` / `right` |

### 5.2 文本字段

- `fontSize`、`letterSpacing`：设备像素，必须 `/scale`。**坑**：折算后如果是数字，要补 `px`，否则 `font-size:15` 非法、整段字号失效。
- `fontFamily`：家族与字重**合写**，格式 `<家族>-<字重>`：
  - `PingFang SC-Regular` → 家族 `PingFang SC`，字重 400
  - `Roboto-Medium` → 家族 `Roboto`，字重 500
  - **坑**：存在 `undefined-undefined`（大量出现），必须整条丢弃
  - **坑**：也存在真字体栈 `Helvetica, "Microsoft YaHei", Arial, sans-serif`（含逗号），此时整串直接用，不要再拆
- `color`：**覆盖率不足**。缺 color 的文本会退化成黑色，红价、灰辅助文案、橙色状态全错。**必须回裁图逐个确认。**
- 渐变文字：会出现 `WebkitBackgroundClip: text` + `WebkitTextFillColor: transparent`，必须同时保留 `backgroundImage`，否则文字透明不可见。
- `lineHeight`：**坑**，经常是离群值（28px 字配 150 行高）。规则：单行且 `盒高/字号 ∈ [1, 2.4]` 时以盒高为准；否则夹到 `字号 × 1.4`。更稳的做法是单行文本直接用 flex 垂直居中。
- `whiteSpace: nowrap` 可信；`overflowWrap`、`textAlign` 可信（归一后）。

### 5.3 `data.value` 里的文本（**坑**）

带 HTML 实体：`2026-11-05&nbsp;10:49`。必须先解码再转义，否则页面显示字面 `&nbsp;`。也见过 `&lt;br&gt;` 表示换行。

### 5.4 图片与内网镜像域名替换

`data.value` 是切图 URL（形如 `https://lanhu-oss-2537-2.lanhuapp.com/FigmaDDSSlicePNG*.png`）：
- 公网环境下，`lanhu-oss-*.lanhuapp.com` 不校验 Cookie，可直接拉取。
- **内网环境关键事实**：许多企业内网放行 `lanhuapp.com`、`dds.lanhuapp.com`、`alipic.lanhuapp.com`，但拦截 `lanhu-oss-*.lanhuapp.com`（表现为 TLS 证书校验失败 `SEC_E_WRONG_PRINCIPAL` 或 HTTP 403）。此时将域名替换为 **`https://alipic.lanhuapp.com/<原路径>`**（例如 `https://alipic.lanhuapp.com/FigmaDDSSlicePNGxxx.png`），并携带蓝湖 `Cookie` 与 `Referer: https://lanhuapp.com/`，即可拿到**逐字节完全一致**的原始切图（注意：不带 Cookie + Referer 访问 `alipic.lanhuapp.com` 会返回 403 空包）。
- 编译器（`lib/assets.mjs` 的 `localizeAssets`）已内置「`lanhu-oss-*` 同域熔断 → `alipic.lanhuapp.com` 镜像带 Cookie+Referer → `reference.png` 无文字遮挡裁切」三级自动回退。
- 切图分辨率通常是逻辑宽的 2/3 倍（@2x/@3x），用 `background-size: 100% 100%` 或 `<img>` + `object-fit` 适配。
- 参考图（整张画布原图）同样在 `alipic.lanhuapp.com`，必须带 `Cookie` + `Referer: https://lanhuapp.com/`。

## 6. 一次编译要扔掉的节点

- 屏外的兄弟节点（标题贴片、其他屏）
- 与父节点完全同 rect 且无视觉属性（无背景/边框/圆角）的纯包装层可以合并，但**只有确认它没有 flex 语义**才合并
- 整屏只有一张整图的情况（`raster: true`）：DDS 没下钻，无从还原

## 7. 判定「这屏能不能做」

| 现象 | 结论 |
|---|---|
| 屏节点只有 1~2 个节点、子节点是单个 `lanhuimage` 撑满 | 整图导入，**DDS 无法还原**，要设计源文件 |
| `raster: true` | 同上 |
| 屏内 90% 节点是 `lanhutext` 且无容器 | 可能是文本型页面，可用 OCR/文案驱动，结构仍要人工搭 |
| 节点数 50~600、有 flex 语义 | 正常，按本流程做 |

## 8. 接口速查

```
# 1) 设计图版本（拿 version_id + 参考图 URL；返回外层是 result，不是 data）
GET https://lanhuapp.com/api/project/image?project_id=&image_id=&dds_status=1[&team_id=]
    → result.versions[].id / .url

# 2) DDS 树地址（只要 Cookie；code 必须是 "00000"）
GET https://dds.lanhuapp.com/api/dds/image/store_schema_revise?version_id=<id>
    Referer: https://dds.lanhuapp.com/
    → data.data_resource_url

# 3) 拉树
GET <data_resource_url>    → 直接就是根节点（含 children）
```

失败语义：少了 Cookie 会返回 `code: "10089"`（登录权限校验失败）；`image_id` 不存在返回 `10009 Image not exist`。
