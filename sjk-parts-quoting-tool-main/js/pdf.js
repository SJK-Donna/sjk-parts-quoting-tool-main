/* SJK Parts Quoting Tool — PDF file from the proposal HTML, in the browser.
 * Renders the proposal at A4 width, captures it with html2canvas and pages it into jsPDF,
 * adding "<company> · <proposal no>" and "Page x of y" to every page.
 * Production should render server-side (headless Chrome) for selectable text — SPEC §8.4;
 * this gives reps a real PDF file in the meantime and wherever print dialogs are blocked.
 */
(function () {
  'use strict';
  const LIBS = [
    'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
  ];
  let loading = null;
  function loadLibs() {
    if (window.html2canvas && window.jspdf) return Promise.resolve();
    if (loading) return loading;
    loading = Promise.all(LIBS.map(src => new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = res; s.onerror = () => rej(new Error('Could not load the PDF library. Check the internet connection.'));
      document.head.appendChild(s);
    }))).catch(e => { loading = null; throw e; });
    return loading;
  }

  const A4_PX = 794; // 210 mm at 96 dpi

  /** @returns {Promise<Blob>} application/pdf */
  async function make(html, footer) {
    const ft = typeof footer === 'string' ? { left: footer, right: '' } : (footer || {});
    await loadLibs();
    const fr = document.createElement('iframe');
    fr.setAttribute('aria-hidden', 'true');
    fr.style.cssText = `position:fixed;left:-10000px;top:0;width:${A4_PX}px;height:1200px;border:0;visibility:hidden`;
    document.body.appendChild(fr);
    try {
      await new Promise(res => { fr.onload = res; fr.srcdoc = html.replace('<body>', '<body class="capture">'); });
      const doc = fr.contentDocument;
      if (doc.fonts && doc.fonts.ready) await doc.fonts.ready;
      const sheet = doc.querySelector('.sheet');
      fr.style.height = Math.max(1200, sheet.scrollHeight + 40) + 'px';

      // Row boundaries (in CSS px from the sheet top) so pages break between table rows, not through them.
      const top = sheet.getBoundingClientRect().top;
      const cuts = [...doc.querySelectorAll('tbody tr, .tot, h4, ol li, .sig')].map(el => el.getBoundingClientRect().top - top);

      const canvas = await window.html2canvas(sheet, { scale: 2, backgroundColor: '#ffffff', windowWidth: A4_PX, useCORS: true, logging: false });
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
      const pageW = 210, pageH = 297, bottom = 12;          // mm; bottom band for the footer
      const pxPerMm = canvas.width / pageW;                  // canvas px per mm
      const cssToCanvas = canvas.width / sheet.offsetWidth;
      const usable = Math.floor((pageH - bottom) * pxPerMm);

      const slices = []; let y = 0;
      while (y < canvas.height - 2) {
        let end = Math.min(y + usable, canvas.height);
        if (end < canvas.height) {
          const best = cuts.map(c => Math.round(c * cssToCanvas)).filter(c => c > y + usable * 0.5 && c <= end).pop();
          if (best) end = best;
        }
        slices.push([y, end]); y = end;
      }
      slices.forEach(([a, b], i) => {
        if (i) pdf.addPage();
        const part = document.createElement('canvas');
        part.width = canvas.width; part.height = b - a;
        part.getContext('2d').drawImage(canvas, 0, a, canvas.width, b - a, 0, 0, canvas.width, b - a);
        pdf.addImage(part.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pageW, (b - a) / pxPerMm);
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(6.5); pdf.setTextColor(86, 103, 111);
        pdf.text(ascii(ft.left || ''), 15, pageH - 8);
        pdf.text(ascii((ft.right ? ft.right + ' · ' : '') + `page ${i + 1} of ${slices.length}`), pageW - 15, pageH - 8, { align: 'right' });
      });
      return pdf.output('blob');
    } finally { fr.remove(); }
  }
  // jsPDF's built-in fonts are Latin-1; keep the footer safe.
  const ascii = s => String(s).replace(/•/g, '·').replace(/[^\x20-\xFF]/g, '');

  window.ProposalPdf = { make, loadLibs };
})();
