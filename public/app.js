// NorthStar — small progressive enhancements. Every page works without this file.
(function () {
  'use strict';

  // Confirm before destructive or repeat actions.
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-confirm]');
    if (el && !window.confirm(el.getAttribute('data-confirm'))) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // Filters that apply as soon as you change them.
  document.querySelectorAll('select[data-autosubmit]').forEach(function (s) {
    s.addEventListener('change', function () { if (s.form) s.form.requestSubmit ? s.form.requestSubmit() : s.form.submit(); });
  });

  // Copy buttons.
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var src = btn.parentElement.querySelector('[data-copy-src]');
      if (!src || !navigator.clipboard) return;
      navigator.clipboard.writeText(src.textContent.trim()).then(function () {
        var t = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = t; }, 1500);
      });
    });
  });

  // Modal dialogs rendered open on the server (first-review celebration).
  document.querySelectorAll('dialog[data-modal][open]').forEach(function (d) {
    if (typeof d.showModal === 'function') { d.close(); d.showModal(); }
  });

  // Show the chosen logo straight away.
  document.querySelectorAll('input[type=file][name=logo]').forEach(function (input) {
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      var box = input.closest('.logo-box') || (input.closest('form') && input.closest('form').querySelector('.logo-box'));
      if (!f || !box || !window.URL) return;
      box.innerHTML = '';
      var img = new Image(); img.alt = 'New logo'; img.src = URL.createObjectURL(f);
      box.appendChild(img); box.appendChild(input);
      box.style.background = ''; box.style.border = '';
    });
  });

  // Message template editor: live preview, token buttons, SMS counter.
  var editor = document.querySelector('[data-template-editor]');
  if (editor) {
    var channel = editor.getAttribute('data-channel');
    var sample = {};
    try { sample = JSON.parse(editor.getAttribute('data-sample')); } catch (err) { sample = {}; }
    var body = editor.querySelector('[data-body]');
    var subject = editor.querySelector('[data-subject]');
    var preview = document.querySelector('[data-preview]');
    var subjectPreview = document.querySelector('[data-subject-preview]');
    var counter = editor.querySelector('[data-counter]');
    var last = body;
    var fill = function (t) {
      return String(t)
        .split('{first_name}').join(sample.first_name)
        .split('{business_name}').join(sample.business_name)
        .split('{service}').join(sample.service)
        .split('{review_link}').join(sample.review_link);
    };
    var gsm = /^[\n\r A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;
    var render = function () {
      var text = fill(body.value).trim();
      if (channel !== 'email' && text.indexOf(sample.review_link) === -1) text += ' ' + sample.review_link;
      if (channel === 'sms' && !/\bSTOP\b/i.test(text)) text += ' Reply STOP to opt out';
      if (preview) preview.textContent = text;
      if (subject && subjectPreview) subjectPreview.textContent = fill(subject.value);
      if (!counter) return;
      var len = Array.from(text).length;
      if (channel === 'sms') {
        var g = gsm.test(text); var single = g ? 160 : 70; var multi = g ? 153 : 67;
        var segs = len <= single ? 1 : Math.ceil(len / multi);
        counter.textContent = len + ' / ' + single + ' · ' + segs + (segs === 1 ? ' text' : ' texts');
        counter.className = 'counter ' + (segs > 1 ? 'warn' : 'ok');
      } else {
        counter.textContent = len + ' characters';
      }
    };
    body.addEventListener('input', render);
    body.addEventListener('focus', function () { last = body; });
    if (subject) { subject.addEventListener('input', render); subject.addEventListener('focus', function () { last = subject; }); }
    editor.querySelectorAll('[data-token]').forEach(function (btn) {
      btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
      btn.addEventListener('click', function () {
        var target = last || body;
        var tok = btn.getAttribute('data-token');
        var s = target.selectionStart != null ? target.selectionStart : target.value.length;
        var en = target.selectionEnd != null ? target.selectionEnd : target.value.length;
        var before = target.value.slice(0, s);
        var pad = before && !/\s$/.test(before) ? ' ' : '';
        target.value = before + pad + tok + target.value.slice(en);
        var pos = s + pad.length + tok.length;
        target.focus(); target.setSelectionRange(pos, pos);
        render();
      });
    });
    render();
  }
})();
