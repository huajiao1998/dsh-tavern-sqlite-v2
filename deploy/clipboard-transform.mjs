// 修复HTTP页面/权限拒绝时的复制动作；异步成功才提示，失败提供可选择的实际文本。
const MARKER = '// [dsh-tavern-clipboard:v1]'
export function applyClipboardTransform(source) {
  if (source.includes(MARKER)) return source
  const pattern = /([\t ]*)function copyErrorText\(text\) \{\n[\s\S]*?\n\1\}/g
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1) throw new Error('错误复制函数锚点不唯一：' + matches.length)
  const indent = matches[0][1]
  const code = `${MARKER}
async function copyErrorText(text, button) {
    const value = String(text || "");
    const doc = document;
    const opener = doc.activeElement;
    let copied = false;
    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
            await navigator.clipboard.writeText(value);
            copied = true;
        }
    } catch (_) { /* HTTP/权限拒绝，继续用户手势内的DOM复制。 */ }
    if (!copied) {
        const area = doc.createElement("textarea");
        area.value = value;
        area.setAttribute("readonly", "");
        area.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;";
        doc.body.appendChild(area);
        try {
            area.focus(); area.select(); area.setSelectionRange(0, value.length);
            copied = typeof doc.execCommand === "function" && doc.execCommand("copy") === true;
        } catch (_) {} finally {
            area.remove();
            try { opener?.focus({ preventScroll: true }); } catch (_) {}
        }
    }
    if (button) {
        button.textContent = copied ? "已复制" : "复制失败";
        setTimeout(() => { if (button.isConnected) button.textContent = "复制"; }, 1500);
    }
    if (!copied) {
        const dialog = doc.createElement("dialog");
        dialog.className = "dsh-tavern-prompt";
        dialog.setAttribute("aria-label", "请手动复制错误信息");
        const panel = doc.createElement("div"); panel.className = "dsh-tavern-prompt-panel";
        const title = doc.createElement("div"); title.textContent = "自动复制被浏览器拒绝，请选择文本手动复制";
        const area = doc.createElement("textarea"); area.value = value; area.readOnly = true;
        area.style.cssText = "width:min(600px,80vw);height:180px;";
        const close = doc.createElement("button"); close.type = "button"; close.textContent = "关闭";
        close.addEventListener("click", () => dialog.close());
        panel.append(title, area, close); dialog.append(panel); doc.body.appendChild(dialog);
        dialog.addEventListener("close", () => { dialog.remove(); try { opener?.focus({ preventScroll: true }); } catch (_) {} });
        try { dialog.showModal(); area.focus(); area.select(); } catch (_) { dialog.remove(); console.warn("复制失败：" + value); }
    }
    return copied;
}`.split('\n').map(line => indent + line).join('\n')
  let next = source.replace(matches[0][0], code)
  const click = 'onClick: function () { copyErrorText(text); }'
  if (next.split(click).length !== 2) throw new Error('错误复制按钮锚点不唯一')
  return next.replace(click, 'onClick: function (event) { void copyErrorText(text, event.currentTarget); }')
}
