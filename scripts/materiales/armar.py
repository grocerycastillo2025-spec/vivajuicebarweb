#!/usr/bin/env python3
"""
Materiales impresos para el local: póster tamaño carta con el QR para
descargar la app, y el QR solo. Al final se comprueba que los QR se leen
(se rasteriza el PDF y se decodifica con OpenCV), igual que un teléfono.

    python3 scripts/materiales/armar.py [URL]

Sin URL usa la de GitHub Pages. Con dominio propio:
    python3 scripts/materiales/armar.py https://app.vivajuicecoffee.com/

Requiere: reportlab, opencv-python (cv2), pdftoppm (poppler) y la fuente
Poppins (Google Fonts). Salida en materiales/.
"""
import os
import subprocess
import sys
import tempfile

import cv2
from reportlab.graphics import renderPDF
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'materiales')
BASE = (sys.argv[1] if len(sys.argv) > 1 else 'https://grocerycastillo2025-spec.github.io/vivajuicebarweb/').rstrip('/') + '/'
URL = BASE + '?instalar=1'
SHOWN = BASE.replace('https://', '').rstrip('/')

GREEN = HexColor('#0E4A2B')
CREAM = HexColor('#F5F0E6')
ORANGE = HexColor('#E87722')
INK = HexColor('#1A1A18')
MUTED = HexColor('#55554D')

FONTS = '/usr/share/fonts/truetype/google-fonts'
pdfmetrics.registerFont(TTFont('Poppins', os.path.join(FONTS, 'Poppins-Regular.ttf')))
pdfmetrics.registerFont(TTFont('Poppins-Bold', os.path.join(FONTS, 'Poppins-Bold.ttf')))
pdfmetrics.registerFont(TTFont('Poppins-Medium', os.path.join(FONTS, 'Poppins-Medium.ttf')))
LOGO = os.path.join(ROOT, 'assets', 'brand', 'viva-logo-cream.png')


def qr(c, url, x, y, size):
    """QR con nivel de corrección M y su margen blanco (4 módulos)."""
    widget = QrCodeWidget(url, barLevel='M', barBorder=4)
    x0, y0, x1, y1 = widget.getBounds()
    w, h = x1 - x0, y1 - y0
    d = Drawing(size, size, transform=[size / w, 0, 0, size / h, 0, 0])
    widget.barFillColor = INK
    d.add(widget)
    renderPDF.draw(d, c, x, y)


def centered(c, text, y, font, size, color):
    c.setFont(font, size)
    c.setFillColor(color)
    c.drawCentredString(letter[0] / 2, y, text)


def poster(path):
    W, H = letter
    c = canvas.Canvas(path, pagesize=letter)
    c.setTitle('VIVA Juice and Coffee — App')
    c.setFillColor(CREAM)
    c.rect(0, 0, W, H, stroke=0, fill=1)

    # Banda verde con el logo en crema.
    band = 2.55 * inch
    c.setFillColor(GREEN)
    c.rect(0, H - band, W, band, stroke=0, fill=1)
    logo = ImageReader(LOGO)
    iw, ih = logo.getSize()
    lh = band - 0.6 * inch
    lw = lh * iw / ih
    c.drawImage(logo, (W - lw) / 2, H - band + 0.3 * inch, width=lw, height=lh, mask='auto')

    centered(c, 'Order ahead from your phone', H - band - 0.62 * inch, 'Poppins-Bold', 29, GREEN)
    centered(c, 'Pide desde tu teléfono', H - band - 1.02 * inch, 'Poppins-Medium', 21, INK)

    # QR grande sobre tarjeta blanca.
    size = 3.7 * inch
    card = size + 0.3 * inch
    cy = H - band - 1.35 * inch - card
    c.setFillColor(white)
    c.setStrokeColor(GREEN)
    c.setLineWidth(3)
    c.roundRect((W - card) / 2, cy, card, card, 18, stroke=1, fill=1)
    qr(c, URL, (W - size) / 2, cy + 0.15 * inch, size)
    centered(c, 'Scan with your camera · Escanea con tu cámara', cy - 0.32 * inch, 'Poppins-Medium', 13, INK)

    # Tres pasos.
    steps = [
        ('1', 'Scan', 'Escanea'),
        ('2', 'Order & pay', 'Pide y paga'),
        ('3', 'Pick up', 'Recoge'),
    ]
    sy = cy - 0.98 * inch
    col = W / 3
    for i, (num, en, es) in enumerate(steps):
        cx = col * i + col / 2
        c.setFillColor(ORANGE)
        c.circle(cx, sy + 0.12 * inch, 0.22 * inch, stroke=0, fill=1)
        c.setFillColor(INK)
        c.setFont('Poppins-Bold', 15)
        c.drawCentredString(cx, sy + 0.06 * inch, num)
        c.setFont('Poppins-Bold', 14)
        c.setFillColor(GREEN)
        c.drawCentredString(cx, sy - 0.32 * inch, en)
        c.setFont('Poppins', 12)
        c.setFillColor(MUTED)
        c.drawCentredString(cx, sy - 0.55 * inch, es)

    centered(c, 'Add it to your home screen and earn rewards', 1.05 * inch, 'Poppins-Medium', 12.5, INK)
    centered(c, 'Agrégala a tu pantalla de inicio y junta puntos', 0.82 * inch, 'Poppins', 12, MUTED)
    centered(c, f'{SHOWN}  ·  31 South St, Freehold, NJ', 0.42 * inch, 'Poppins', 9.5, MUTED)
    c.showPage()
    c.save()


def qr_only(path):
    side = 4 * inch
    c = canvas.Canvas(path, pagesize=(side, side + 0.5 * inch))
    c.setTitle('VIVA Juice and Coffee — QR de la app')
    c.setFillColor(white)
    c.rect(0, 0, side, side + 0.5 * inch, stroke=0, fill=1)
    qr(c, URL, 0, 0.5 * inch, side)
    c.setFont('Poppins-Medium', 11)
    c.setFillColor(INK)
    c.drawCentredString(side / 2, 0.2 * inch, 'VIVA Juice and Coffee · App')
    c.showPage()
    c.save()


def render(pdf, png, dpi):
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(['pdftoppm', '-png', '-r', str(dpi), '-singlefile', pdf, os.path.join(tmp, 'p')], check=True)
        os.replace(os.path.join(tmp, 'p.png'), png)


def read_qr(png):
    img = cv2.imread(png)
    data, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    if data:
        return data
    # Como lo vería un teléfono a media distancia: más chico.
    small = cv2.resize(img, None, fx=0.35, fy=0.35, interpolation=cv2.INTER_AREA)
    data, _, _ = cv2.QRCodeDetector().detectAndDecode(small)
    return data


def main():
    os.makedirs(OUT, exist_ok=True)
    poster_pdf = os.path.join(OUT, 'poster-carta.pdf')
    qr_pdf = os.path.join(OUT, 'qr-app.pdf')
    poster(poster_pdf)
    qr_only(qr_pdf)
    render(poster_pdf, os.path.join(OUT, 'poster-carta.png'), 150)
    render(qr_pdf, os.path.join(OUT, 'qr-app.png'), 300)

    bad = []
    for png in ['poster-carta.png', 'qr-app.png']:
        got = read_qr(os.path.join(OUT, png))
        print(f'{png}: {got or "NO SE LEE"}')
        if got != URL:
            bad.append(png)
    if bad:
        sys.exit(f'El QR no se lee bien en: {", ".join(bad)}')
    print(f'OK: los dos QR llevan a {URL}')


if __name__ == '__main__':
    main()
