#!/usr/bin/env python3
"""
產生 LINE 圖文選單底圖（2500x1686，3 欄 2 列共 6 格）。

輸出：public/richmenu.png

**多數人不需要跑這支。** repo 裡已經附了產好的 public/richmenu.png，
clone 下來直接部署就能用。只有想改按鈕文字或配色時才需要重新產生。

用法：
    pip install pillow
    python3 scripts/generate-richmenu.py

找不到中文字型時可以自己指定：
    python3 scripts/generate-richmenu.py --font-bold /path/to/bold.ttf --font-light /path/to/light.ttf

改了下面的 CELLS，記得 lib/richmenu.ts 的 areas 也要對應調整，
兩邊的格數與順序必須一致（左上到右下），否則使用者會按到錯的功能。
"""
import argparse
import os
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit('需要 Pillow：pip install pillow\n'
             '（或者直接用 repo 裡附的 public/richmenu.png，不必跑這支腳本）')

W, H = 2500, 1686
COLS, ROWS = 3, 2
CW, CH = W // COLS, H // ROWS

# (emoji, 主標, 副標)
# 六格都是名片管理功能。改這裡要同步改 lib/richmenu.ts 的 areas。
CELLS = [
    ('📸', '掃名片',   '拍照自動建檔'),
    ('📋', '待跟進',   '今天該聯絡誰'),
    ('🔍', '找人',     '姓名或公司'),
    ('🎪', '展場模式', '連續掃名片'),
    ('📊', '名片統計', '累積與分佈'),
    ('📥', '匯出名單', '下載 CSV'),
]

# 中文字型候選，依 macOS / Windows / Linux 順序找。
# 這支腳本原本只寫死 macOS 路徑，公開給所有人之後 Windows 與 Linux 使用者
# 會直接噴 OSError，而且錯誤訊息看不出是字型問題。
BOLD_CANDIDATES = [
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    'C:/Windows/Fonts/msjh.ttc',
    'C:/Windows/Fonts/msjhbd.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
    '/usr/share/fonts/truetype/arphic/uming.ttc',
]
LIGHT_CANDIDATES = [
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    'C:/Windows/Fonts/msjh.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Light.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/arphic/uming.ttc',
]
# 彩色 emoji 字型各平台的尺寸限制不同：
# Apple Color Emoji 只吃固定點陣尺寸，Noto Color Emoji 是 109，Segoe 比較寬鬆。
# 全部試一輪，都失敗就不放 emoji，版面改成只有文字，仍然可用。
EMOJI_CANDIDATES = [
    '/System/Library/Fonts/Apple Color Emoji.ttc',
    'C:/Windows/Fonts/seguiemj.ttf',
    '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
    '/usr/share/fonts/truetype/noto-color-emoji/NotoColorEmoji.ttf',
]
EMOJI_SIZES = (160, 109, 128, 137, 96, 64)


def find_font(candidates, override):
    if override:
        if not os.path.exists(override):
            sys.exit(f'指定的字型不存在：{override}')
        return override
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


def load_emoji(override):
    paths = [override] if override else EMOJI_CANDIDATES
    for p in paths:
        if not p or not os.path.exists(p):
            continue
        for size in EMOJI_SIZES:
            try:
                return ImageFont.truetype(p, size), size
            except OSError:
                continue
    return None, 0


def gradient_bg():
    """深藍到深灰的垂直漸層，低調專業，白字對比夠。"""
    bg = Image.new('RGB', (1, H))
    top, bottom = (11, 18, 32), (26, 37, 61)
    px = bg.load()
    for y in range(H):
        t = y / (H - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return bg.resize((W, H))


def emoji_img(font, native, ch, target):
    """彩色 emoji 只能用字型支援的尺寸算，算完再縮放到想要的大小。"""
    layer = Image.new('RGBA', (native * 2, native * 2), (0, 0, 0, 0))
    ImageDraw.Draw(layer).text((native // 2, native // 2), ch,
                               font=font, embedded_color=True, anchor='mm')
    box = layer.getbbox()
    if not box:
        return None
    return layer.crop(box).resize((target, target), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--font-bold', help='主標字型路徑')
    ap.add_argument('--font-light', help='副標字型路徑')
    ap.add_argument('--emoji', help='彩色 emoji 字型路徑')
    args = ap.parse_args()

    bold = find_font(BOLD_CANDIDATES, args.font_bold)
    light = find_font(LIGHT_CANDIDATES, args.font_light) or bold
    if not bold:
        sys.exit(
            '找不到中文字型。\n'
            '\n'
            'repo 裡已經附了產好的 public/richmenu.png，直接部署就能用，\n'
            '只有要改按鈕文字時才需要跑這支腳本。\n'
            '\n'
            '真的要跑的話，裝一套中文字型（例如 Noto Sans CJK）後用參數指定：\n'
            '  python3 scripts/generate-richmenu.py --font-bold /path/to/font.ttf'
        )

    emoji_font, emoji_native = load_emoji(args.emoji)
    if not emoji_font:
        print('找不到彩色 emoji 字型，這次產圖只放文字（功能不受影響）')

    img = gradient_bg()
    d = ImageDraw.Draw(img, 'RGBA')
    f_title = ImageFont.truetype(bold, 104)
    f_sub = ImageFont.truetype(light, 52)

    # 沒有 emoji 時整體往下移，讓文字在格子裡置中，不會上面空一塊
    title_y, sub_y = (500, 640) if emoji_font else (360, 500)

    for i, (emo, title, sub) in enumerate(CELLS):
        col, row = i % COLS, i // COLS
        cx = col * CW + CW // 2
        top = row * CH

        if emoji_font:
            icon = emoji_img(emoji_font, emoji_native, emo, 230)
            if icon:
                img.paste(icon, (cx - icon.width // 2, top + 150), icon)

        d.text((cx, top + title_y), title, font=f_title, fill=(255, 255, 255), anchor='ma')
        d.text((cx, top + sub_y), sub, font=f_sub, fill=(148, 163, 184), anchor='ma')

    # 格線：細且淡，只用來分隔，不搶視覺
    line = (255, 255, 255, 26)
    for c in range(1, COLS):
        d.line([(c * CW, 40), (c * CW, H - 40)], fill=line, width=3)
    d.line([(60, CH), (W - 60, CH)], fill=line, width=3)

    # 輸出路徑用腳本位置推算，不依賴當下的工作目錄，
    # 從別的資料夾呼叫時才不會把圖寫到別的地方去
    out = Path(__file__).resolve().parents[1] / 'public' / 'richmenu.png'
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, 'PNG', optimize=True)
    print(f'已輸出 {out}（{W}x{H}，{out.stat().st_size // 1024} KB）')


if __name__ == '__main__':
    main()
