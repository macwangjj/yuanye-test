# 无缝印花工作台（新版测试网站）

当前目录是新版测试网站，用于继续优化四方连续 / 无缝循环方案，避免和旧版正式网站混淆。

这是一个可在本地或办公室局域网运行的批量无缝印花生成工具。它会把参考图提交给 OpenAI 图片编辑接口，生成四方连续图案，并提供 JPG 下载。

## 使用方式

1. 复制 `.env.example` 为 `.env`，把里面的 `OPENAI_API_KEY` 换成你的真实 Key。
   如果使用书标标接口，设置 `OPENAI_BASE_URL="https://api.shubiaobiao.com/v1"`。
2. 双击 `start.command`。如果还没有配置 Key，它会让你粘贴一次并自动保存。
3. 本机打开启动窗口里显示的地址，通常是 `http://127.0.0.1:4185`。
4. 批量上传参考图，点击「一键开始生成」。
5. 每张图生成完成后，点击「下载 JPG」。

## 办公室同网络使用

本机使用请双击 `start.command`。

如果要让同办公室同网络的人一起访问，请双击 `start-lan.command`，它会监听 `0.0.0.0:4185`。同一个局域网的人可以访问：

`http://你的电脑局域网 IP:4185`

API Key 只放在运行服务的电脑环境变量里，不会发到其他人的浏览器。

## 云端免费部署（Render）

项目已经带 `render.yaml`，可部署到 Render 的免费 Web Service。当前建议的免费测试域名是：

`yuanye-test.onrender.com`

如果这个名字被占用，可以改成：

- `yuanye-pattern.onrender.com`
- `yuanye-repeat.onrender.com`
- `yuanye-tile.onrender.com`

1. 把项目上传到 GitHub 私有仓库。
2. 在 Render 新建 Blueprint 或 Web Service，选择这个仓库。
3. 设置环境变量：
   - `OPENAI_API_KEY`：OpenAI 兼容接口 Key
   - `OPENAI_BASE_URL`：`https://maimai.it.com/v1`
   - `OPENAI_IMAGE_MODEL`：`gpt-image-2`
   - `OPENAI_CHAT_MODEL`：`gpt-5.5`
   - `YUANYE_PASSWORD`：登录网站用的授权密码
   - `YUANYE_HOST`：`0.0.0.0`
4. 部署完成后，打开 Render 给出的域名，输入 `YUANYE_PASSWORD` 后使用。

注意：免费 Web Service 可能会空闲休眠，第一次打开会慢一点；免费服务没有稳定持久磁盘，历史图片如果需要长期保存，后续建议接 Supabase Storage 或对象存储。

## 接口配置

`.env` 示例：

```bash
OPENAI_API_KEY="你的接口 Key"
OPENAI_BASE_URL="https://maimai.it.com/v1"
OPENAI_IMAGE_MODEL="gpt-image-2"
OPENAI_CHAT_MODEL="gpt-5.5"
PORT=4185
```

`OPENAI_BASE_URL` 可以填写根地址或 `/v1` 地址，程序会统一处理成 `/v1` 接口地址。

## 关键规格

- 四方连续 / seamless pattern
- 稀疏型构图
- 风格、配色、元素气质与参考图一致
- 适合服装面料数码印花
- 下载 JPG 会按 `4961 × 7559 px` 画布导出，并写入 300dpi JFIF 标记

## 四方连续修复与测试

新版测试站会先检查原始导出图，再按结果进入 AI Offset 修缝、`repairSeams` 或重生。AI 修缝会保留更好的版本，必要时做第二次细修；本地融合会保留内侧纹理，减少硬边、糊边和平涂条带。当前质量闸会额外模拟 2×2 平铺预览，直接检测平铺中心线、光晕和假边带，避免“单张看不出、平铺后明显”的误判；导出端也会做基础印花清晰度收尾，并拒绝明显模糊的成品。未通过当前质检认证的图片只能预览、复检或继续修复，不会开放成品下载和批量打包。更完整的修复策略见 [docs/SEAM_REPAIR.md](docs/SEAM_REPAIR.md)。

运行自动测试：

```bash
npm test
```

## 注意

图片模型的原始生成尺寸会先按可用竖版比例生成，再由前端导出成目标 JPG 文件。面料打样前仍建议在设计软件中做 3 × 3 平铺复核。
