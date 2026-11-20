# 皮肤与图标制作指南

> 这份文档写给**要制作新皮肤或应用图标的人**（包括你自己用 AI 生图时）。
> 技术契约在 `src/core/motion.ts`；渲染实现见 `docs/ARCHITECTURE.md` 第八节。

## 一、先搞清楚一件事：AI 生图不能直接产出图集

不要把「8 列 × 14 行的动画图集」丢给 AI 图像模型。它做不到，原因是：

- 模型没有「这一格必须是 walk 第 3 帧」的概念，帧与帧之间角色会变形、颜色会漂移
- 一次生成 28 个动作，风格必然不统一

**可行路径**（本文档按此设计）：

```
第 1 步  AI 生成「角色设定图」        ← 锁风格，不追求动作
第 2 步  按设定图逐个动作生成单帧    ← 一次只要 1 张，或 1 组 4–8 帧
第 3 步  npm run pack:skin 拼成图集  ← 脚本保证网格对齐与清单正确
第 4 步  npm run test:e2e 验收
```

## 二、角色设定 prompt 模板

先把风格定下来，后面所有动作都参考这张图。

```
2D game sprite, cute chibi cat companion for a desktop pet app,
front view, standing, full body, centered,
soft pastel palette: cream white fur (#FFF6F8) with soft pink points (#F6CFD9),
large round dark eyes with a white highlight, tiny pink nose,
short plump body, four visible legs with white paws,
simple flat shading, clean bold outline, no texture detail,
transparent background, 512x512, no text, no watermark
```

> 关键约束都写进 prompt 了：**纯色背景（便于抠图）**、**正面站姿**、**四腿可见**、
> **扁平配色**、**无文字**。缺一条就会在后续动作里出问题。

生成后可微调的方向（按你的产品调性选）：

| 想要的感觉 | 加进 prompt 的词 |
|---|---|
| 更「宠物」 | `slightly shaggy fur`, `big head small body` |
| 更「游戏感」 | `pixel art, 64x64 native, limited palette` |
| 更「手绘」 | `storybook illustration, soft crayon texture` |
| 更「高级」 | `minimal vector style, single accent color` |

## 三、动作清单与每类动作的 prompt

契约要求 **14 个动作**，分两个视角。下面是每个动作的画法要点和 prompt 后缀。

追加到设定 prompt 后面的**动作后缀**：

### 正面视角（front）— 永不镜像

| 动作 | 帧数 / fps | 画法要点 | prompt 后缀 |
|---|---|---|---|
| `idle` | 4 / 6 | 呼吸起伏、尾巴轻摆 | `idle breathing, tail gently swaying, 4-frame loop` |
| `tap` | 2 / 8 | 眯眼笑、腮红、头顶爱心 | `happy closed eyes, blushing, small heart above head` |
| `sleep` | 2 / 2 | 闭眼、耳朵压低、ZZZ | `sleeping, closed eyes, ears lowered, ZZZ above` |
| `wake` | 4 / 10 | 眯眼→睁眼、伸展开 | `waking up, eyes opening, small stretch` |
| `stretch` | 6 / 6 | 前倾、前腿前伸 | `doing a big stretch, front legs extended forward` |
| `groom` | 6 / 8 | 低头舔爪 | `licking its paw, head lowered` |
| `annoyed` | 4 / 8 | 耳朵后压、张嘴 | `annoyed, ears flattened back, mouth open` |
| `dizzy` | 4 / 10 | 眯眼、头顶转圈星 | `dizzy, swirly eyes, stars circling above head` |

### 侧影视角（side）— 可镜像，素材一律朝右

| 动作 | 帧数 / fps | 画法要点 | prompt 后缀 |
|---|---|---|---|
| `walk` | 6 / 10 | 四肢交替 | `side view walking to the right, legs alternating, 6-frame walk cycle` |
| `climb` | 6 / 8 | 身体贴墙、前爪向上抓 | `side view climbing upward, body against wall, front paws reaching up` |
| `hang` | 4 / 6 | **爪子勾住上方、身体下垂、头在下** | `side view hanging upside down from a ledge by its front paws, body hanging straight down` |
| `fall` | 2 / 6 | 四肢张开、尾巴竖起 | `side view falling, limbs splayed, tail up` |
| `land` | 4 / 10 | 压缩→回弹 | `side view landing, squashed on impact then springing back` |
| `held` | 2 / 4 | 四肢垂下、被拎起 | `side view being held up by the scruff, limbs dangling` |

### 三个必须写进 prompt 的句式

1. **`character sheet, consistent design`** —— 跨动作一致性的提示
2. **`transparent background` 或纯色背景** —— 便于抠图
3. **`no text, no watermark, no border`** —— 避免混入无关元素

### `hang` 的特别提醒

**不要**让 AI 画「旋转 180° 的站姿」。那会得到一只脸倒过来的猫，看起来像翻车。
要画的是**真实的倒挂姿态**：爪子在上（勾住）、身体垂直向下、头在身体下方。

## 四、图标 prompt

应用图标（`resources/icon.png`，256×256 起）和托盘图标（`resources/tray.png`，32×32）
需要另外生成。

```
app icon for a desktop pet app, the same chibi cat from the sprite sheet,
head and shoulders only, facing forward, friendly expression,
soft rounded square background with a subtle gradient (#2A2333 → #3A3145),
centered composition, thick enough silhouette to read at 32px,
flat vector style, no text, no shadow artifacts, 1024x1024
```

**托盘图标**（32px 必须单独检查）：

```
simplified monochrome silhouette of the same cat head, 32x32,
high contrast, single color white on transparent, no details finer than 2px
```

> 32px 下任何细节都会糊成一团。托盘图标要做「剪影测试」：缩小到 32×32，
> 还能一眼认出是猫，才算合格。

## 五、从单帧到图集：`npm run pack:skin`

把 AI 生成的单帧放到一个目录，按下面的命名规则，然后运行脚本：

```
skins/my-cat/
  idle-0.png  idle-1.png  idle-2.png  idle-3.png
  walk-0.png  walk-1.png  ... walk-5.png
  hang-0.png  hang-1.png  hang-2.png  hang-3.png
  ...
  meta.json     ← 可选，覆盖帧数/fps
```

```bash
npm run pack:skin -- skins/my-cat --id my-cat --name "我的猫"
```

脚本会：

1. 读取每个动作的帧，按 manifest 规则排版成图集
2. 校验：帧尺寸一致、必需动作齐全、透明通道存在
3. 产出 `cat.png` + `manifest.json`，可直接给渲染器使用

`meta.json` 可以覆盖默认参数（例如你想让 walk 慢一点）：

```json
{
  "id": "my-cat",
  "name": "我的猫",
  "fps": { "walk": 8, "idle": 4 },
  "size": 96
}
```

## 六、验收清单

出图后逐项自查，全部通过才算能接入：

- [ ] 14 个动作齐全（缺的可以用 `fallbacks` 指向相近动作）
- [ ] 每帧尺寸一致，且是 2 的幂或明确的 `size`（推荐 48 / 64 / 96）
- [ ] 背景透明（或纯色，能一键抠除）
- [ ] **正面动作没有左右翻转**；侧影一律朝右（渲染时镜像）
- [ ] `hang` 是真实倒挂姿态，不是旋转过的站姿
- [ ] 脚掌对齐：`manifest.anchors.front.y` 与 `anchors.side.y` 都在脚底
- [ ] `npm run test:e2e` 通过，真机看一眼走路与攀爬不抖动

## 七、常见错误

| 现象 | 原因 | 修法 |
|---|---|---|
| 角色每帧变形 | 每帧单独生成，没有参考设定图 | 用「同角色、同姿势、只改腿部」的 prompt，并在提示里附上设定图 |
| 图集错位、帧被切 | 单帧尺寸不一致 | 打包前统一 resize 到同一尺寸 |
| 倒挂像翻车 | 用旋转实现 | 单独生成 hang 姿态 |
| 镜像后阴影方向不对 | 阴影画进了角色帧 | 阴影独立成层，不参与镜像 |
| 托盘图标糊 | 细节太多 | 做剪影视图，32px 单独检查 |
| 换肤后动作错乱 | manifest 的 row/frames 与实际不符 | 用 `pack:skin` 生成，不要手写 manifest |
