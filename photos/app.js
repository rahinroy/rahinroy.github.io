var cropper = null;
var sourceFilename = 'cropped';
var cropAspectRatio = null;
var fileSizeTimer = null;

// Custom instant tooltip
var tooltipEl = document.createElement('div');
tooltipEl.id = 'tooltip';
tooltipEl.classList.add('hidden');
document.body.appendChild(tooltipEl);

function showTooltip(el) {
  var text = el.dataset.tooltip;
  if (!text) return;
  tooltipEl.textContent = text;
  tooltipEl.classList.remove('hidden');
  var rect = el.getBoundingClientRect();
  var left = Math.min(rect.left, window.innerWidth - tooltipEl.offsetWidth - 8);
  tooltipEl.style.left = Math.max(0, left) + 'px';
  tooltipEl.style.top = (rect.bottom + 6) + 'px';
}

function hideTooltip() {
  tooltipEl.classList.add('hidden');
}

['resize-toggle-label', 'maxsize-toggle-label'].forEach(function(id) {
  var el = document.getElementById(id);
  el.addEventListener('mouseenter', function() { showTooltip(this); });
  el.addEventListener('mouseleave', hideTooltip);
});

var extMap = {
  'image/png': 'png',
  'image/jpeg': 'jpg'
};

function loadImage(file) {
  var fr = new FileReader();
  fr.onload = function(e) {
    var imgEl = document.getElementById('crop-image');
    imgEl.src = e.target.result;
    imgEl.onload = function() {
      if (cropper !== null) {
        cropper.destroy();
        cropper = null;
      }
      initCropper();
    };
  };
  sourceFilename = file.name.split('.')[0];
  document.getElementById('filename-input').value = sourceFilename + '_cropped';
  fr.readAsDataURL(file);
  document.getElementById('upload-zone').classList.add('hidden');
  document.getElementById('workspace').classList.remove('hidden');
}

function initCropper() {
  var imgEl = document.getElementById('crop-image');
  cropper = new Cropper(imgEl, {
    viewMode: 1,
    dragMode: 'move',
    autoCropArea: 0.8,
    responsive: true,
    restore: false,
    guides: true,
    center: true,
    highlight: false,
    cropBoxMovable: true,
    cropBoxResizable: true,
    toggleDragModeOnDblClick: false,
    ready: onCropperReady
  });

  imgEl.addEventListener('crop', function(e) {
    var d = e.detail;
    if (d.width > 0 && d.height > 0) {
      cropAspectRatio = d.width / d.height;
      if (document.getElementById('resize-toggle').checked) {
        document.getElementById('out-width').value = Math.round(d.width);
        document.getElementById('out-height').value = Math.round(d.height);
      }
      scheduleFileSizeUpdate();
    }
  });
}

function onCropperReady() {
  var data = cropper.getData();
  cropAspectRatio = data.width / data.height;
  updateFileSize();
}

function setRatio(btn, ratio) {
  document.querySelectorAll('.ratio-btn').forEach(function(b) {
    b.classList.remove('active');
  });
  btn.classList.add('active');

  if (ratio === 'custom') {
    document.getElementById('custom-ratio-inputs').classList.remove('hidden');
    return;
  }

  document.getElementById('custom-ratio-inputs').classList.add('hidden');
  cropper.setAspectRatio(ratio);
}

function applyCustomRatio() {
  var w = parseFloat(document.getElementById('custom-w').value);
  var h = parseFloat(document.getElementById('custom-h').value);
  if (w > 0 && h > 0) {
    cropper.setAspectRatio(w / h);
  }
}

function syncOutputDimensions(changedField) {
  if (!document.getElementById('lock-ratio').checked || !cropAspectRatio) return;
  var wInput = document.getElementById('out-width');
  var hInput = document.getElementById('out-height');
  if (changedField === 'width') {
    var w = parseInt(wInput.value);
    if (w > 0) hInput.value = Math.round(w / cropAspectRatio);
  } else {
    var h = parseInt(hInput.value);
    if (h > 0) wInput.value = Math.round(h * cropAspectRatio);
  }
}

function getDataURLBytes(dataURL) {
  return Math.round((dataURL.length - dataURL.indexOf(',') - 1) * 3 / 4);
}

function scaleCanvas(src, w, h) {
  var dst = document.createElement('canvas');
  dst.width = w;
  dst.height = h;
  dst.getContext('2d').drawImage(src, 0, 0, w, h);
  return dst;
}

function fitToMaxSize(canvas, format, quality, targetBytes) {
  // For lossy formats: binary search on quality first
  if (format !== 'image/png') {
    var lo = 0.01, hi = quality;
    for (var i = 0; i < 14; i++) {
      var mid = (lo + hi) / 2;
      if (getDataURLBytes(canvas.toDataURL(format, mid)) <= targetBytes) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    quality = lo;
    if (getDataURLBytes(canvas.toDataURL(format, quality)) <= targetBytes) {
      return canvas.toDataURL(format, quality);
    }
  }

  // Binary search on scale factor (PNG, or lossy still too large at min quality)
  var lo = 0.0, hi = 1.0;
  for (var i = 0; i < 14; i++) {
    var mid = (lo + hi) / 2;
    var w = Math.max(1, Math.round(canvas.width * mid));
    var h = Math.max(1, Math.round(canvas.height * mid));
    if (getDataURLBytes(scaleCanvas(canvas, w, h).toDataURL(format, quality)) <= targetBytes) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  var finalW = Math.max(1, Math.round(canvas.width * lo));
  var finalH = Math.max(1, Math.round(canvas.height * lo));
  return scaleCanvas(canvas, finalW, finalH).toDataURL(format, quality);
}

function updateFileSize() {
  if (!cropper) return;
  var outWidth, outHeight;
  if (document.getElementById('resize-toggle').checked) {
    var wVal = parseInt(document.getElementById('out-width').value);
    var hVal = parseInt(document.getElementById('out-height').value);
    outWidth = isNaN(wVal) || wVal <= 0 ? undefined : wVal;
    outHeight = isNaN(hVal) || hVal <= 0 ? undefined : hVal;
  }
  var format = document.getElementById('format-select').value;
  var quality = parseFloat(document.getElementById('quality-slider').value);
  var canvas = cropper.getCroppedCanvas({ width: outWidth, height: outHeight });

  var dataURL;
  if (document.getElementById('maxsize-toggle').checked) {
    var sizeVal = parseFloat(document.getElementById('maxsize-input').value);
    var unit = document.getElementById('maxsize-unit').value;
    if (!isNaN(sizeVal) && sizeVal > 0) {
      var targetBytes = sizeVal * (unit === 'MB' ? 1024 * 1024 : 1024);
      dataURL = fitToMaxSize(canvas, format, quality, targetBytes);
    } else {
      dataURL = canvas.toDataURL(format, quality);
    }
  } else {
    dataURL = canvas.toDataURL(format, quality);
  }

  var bytes = getDataURLBytes(dataURL);
  var label = document.getElementById('file-size-value');
  if (bytes < 1024 * 1024) {
    label.textContent = (bytes / 1024).toFixed(0) + ' KB';
  } else {
    label.textContent = (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }
  document.getElementById('file-size-display').classList.remove('hidden');
}

function scheduleFileSizeUpdate() {
  clearTimeout(fileSizeTimer);
  fileSizeTimer = setTimeout(updateFileSize, 300);
}

function toggleQualityControl() {
  var format = document.getElementById('format-select').value;
  var group = document.getElementById('quality-group');
  var maxsizeOn = document.getElementById('maxsize-toggle').checked;
  if (format === 'image/png' || maxsizeOn) {
    group.classList.add('hidden');
  } else {
    group.classList.remove('hidden');
  }
  document.getElementById('filename-ext').textContent = '.' + extMap[format];
  updateFileSize();
}

function downloadCropped() {
  var outWidth, outHeight;
  if (document.getElementById('resize-toggle').checked) {
    var wVal = parseInt(document.getElementById('out-width').value);
    var hVal = parseInt(document.getElementById('out-height').value);
    outWidth = isNaN(wVal) || wVal <= 0 ? undefined : wVal;
    outHeight = isNaN(hVal) || hVal <= 0 ? undefined : hVal;
  }

  var format = document.getElementById('format-select').value;
  var quality = parseFloat(document.getElementById('quality-slider').value);

  var croppedCanvas = cropper.getCroppedCanvas({
    width: outWidth,
    height: outHeight,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'high'
  });

  var dataURL;
  if (document.getElementById('maxsize-toggle').checked) {
    var sizeVal = parseFloat(document.getElementById('maxsize-input').value);
    var unit = document.getElementById('maxsize-unit').value;
    var targetBytes = sizeVal * (unit === 'MB' ? 1024 * 1024 : 1024);
    dataURL = fitToMaxSize(croppedCanvas, format, quality, targetBytes);
    // Update displayed size to reflect the fitted result
    var actualBytes = getDataURLBytes(dataURL);
    var label = document.getElementById('file-size-value');
    if (actualBytes < 1024 * 1024) {
      label.textContent = (actualBytes / 1024).toFixed(0) + ' KB';
    } else {
      label.textContent = (actualBytes / (1024 * 1024)).toFixed(2) + ' MB';
    }
    document.getElementById('file-size-display').classList.remove('hidden');
  } else {
    dataURL = croppedCanvas.toDataURL(format, quality);
  }

  var ext = extMap[format];
  var filename = document.getElementById('filename-input').value.trim() || sourceFilename + '_cropped';
  var link = document.createElement('a');
  link.download = filename + '.' + ext;
  link.href = dataURL;
  link.click();
}

function resetCrop() {
  cropper.reset();
}

function initDropZone() {
  var zone = document.getElementById('upload-zone');

  zone.addEventListener('dragenter', function(e) {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragover', function(e) {
    e.preventDefault();
  });
  zone.addEventListener('dragleave', function(e) {
    zone.classList.remove('drag-over');
  });
  zone.addEventListener('drop', function(e) {
    e.preventDefault();
    zone.classList.remove('drag-over');
    var file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      loadImage(file);
    }
  });
}

// Wire up all events
document.getElementById('file-input').addEventListener('change', function() {
  if (this.files[0]) loadImage(this.files[0]);
});

initDropZone();

document.querySelectorAll('.ratio-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var ratioStr = this.dataset.ratio;
    if (ratioStr === 'custom') {
      setRatio(this, 'custom');
    } else {
      setRatio(this, parseFloat(ratioStr)); // NaN = free mode (Cropper.js convention)
    }
  });
});

document.getElementById('apply-custom-ratio').addEventListener('click', applyCustomRatio);

function setToggleDisabled(checkboxId, labelId, disabled, reason) {
  var checkbox = document.getElementById(checkboxId);
  var label = document.getElementById(labelId);
  checkbox.disabled = disabled;
  label.classList.toggle('toggle-disabled', disabled);
  label.dataset.tooltip = disabled ? reason : '';
}

document.getElementById('resize-toggle').addEventListener('change', function() {
  var inputs = document.getElementById('resize-inputs');
  if (this.checked) {
    inputs.classList.remove('hidden');
    // Pre-fill with current crop's native pixel dimensions
    var data = cropper.getData();
    document.getElementById('out-width').value = Math.round(data.width);
    document.getElementById('out-height').value = Math.round(data.height);
    cropAspectRatio = data.width / data.height;
    setToggleDisabled('maxsize-toggle', 'maxsize-toggle-label', true, 'Disable custom output size to use custom file size');
  } else {
    inputs.classList.add('hidden');
    document.getElementById('out-width').value = '';
    document.getElementById('out-height').value = '';
    setToggleDisabled('maxsize-toggle', 'maxsize-toggle-label', false, '');
  }
});

document.getElementById('out-width').addEventListener('input', function() {
  syncOutputDimensions('width');
  scheduleFileSizeUpdate();
});
document.getElementById('out-height').addEventListener('input', function() {
  syncOutputDimensions('height');
  scheduleFileSizeUpdate();
});

document.getElementById('format-select').addEventListener('change', toggleQualityControl);

document.getElementById('quality-slider').addEventListener('input', function() {
  document.getElementById('quality-value').textContent = parseFloat(this.value).toFixed(2);
  scheduleFileSizeUpdate();
});

document.getElementById('maxsize-toggle').addEventListener('change', function() {
  document.getElementById('maxsize-inputs').classList.toggle('hidden', !this.checked);
  if (this.checked) {
    setToggleDisabled('resize-toggle', 'resize-toggle-label', true, 'Disable custom file size to use custom output size');
  } else {
    setToggleDisabled('resize-toggle', 'resize-toggle-label', false, '');
  }
  toggleQualityControl();
});

document.getElementById('maxsize-input').addEventListener('input', scheduleFileSizeUpdate);
document.getElementById('maxsize-unit').addEventListener('change', scheduleFileSizeUpdate);

document.getElementById('download-btn').addEventListener('click', downloadCropped);
document.getElementById('reset-btn').addEventListener('click', resetCrop);
