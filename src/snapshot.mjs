// 页面侧函数。Playwright 会把它们序列化到目标 frame 中执行，
// 因此每个导出函数都必须自包含：只依赖参数和浏览器全局，不引用模块作用域。

export function snapshotDocument(options) {
  const config = options || {};
  const selectors = Array.isArray(config.selectors) ? config.selectors : [];
  const tokenAttribute = config.tokenAttribute || 'data-catalog-frame';
  const tokenPrefix = config.tokenPrefix || 'frame';
  const maxNodes = Number.isFinite(config.maxNodes) ? config.maxNodes : 8000;

  const nodes = [];
  const slots = [];
  const frames = [];
  const unresolved = [];
  const roots = [];
  const seen = new Set();
  let rootSerial = 0;
  let tokenSerial = 0;
  let truncated = false;

  function labelOf(node) {
    if (!node || node.nodeType === 9) return '#document';
    const tag = node.tagName ? node.tagName.toLowerCase() : '#node';
    const id = node.id ? '#' + node.id : '';
    const slot = node.getAttribute && node.getAttribute('slot');
    return tag + id + (slot ? '[slot=' + JSON.stringify(slot) + ']' : '');
  }

  function rootPathOf(node) {
    const chain = [];
    let root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    while (root && root.nodeType === 11) {
      chain.unshift({ kind: 'shadow-root', mode: root.mode || 'unknown', host: labelOf(root.host) });
      root = root.host && typeof root.host.getRootNode === 'function' ? root.host.getRootNode() : null;
    }
    return [{ kind: 'document', url: location.href }].concat(chain);
  }

  function ancestorPathOf(node) {
    const path = [];
    let current = node.parentNode;
    while (current) {
      if (current.nodeType === 1) {
        path.push(labelOf(current));
        current = current.parentNode;
      } else if (current.nodeType === 11) {
        path.push('#shadow-root');
        current = current.host;
      } else {
        current = current.parentNode;
      }
    }
    return path.reverse();
  }

  function deviceOf(node) {
    let current = node;
    while (current) {
      if (
        current.nodeType === 1 &&
        (current.hasAttribute('data-device') || current.hasAttribute('data-generation'))
      ) {
        return {
          device: current.getAttribute('data-device'),
          generation: current.getAttribute('data-generation'),
          at: labelOf(current),
          rootPath: rootPathOf(current),
          path: ancestorPathOf(current)
        };
      }
      if (current.nodeType === 11 && current.host) current = current.host;
      else current = current.parentNode;
    }
    return null;
  }

  function styleVisible(element) {
    let current = element;
    while (current) {
      const style = getComputedStyle(current);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.contentVisibility === 'hidden' ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
      if (current.parentElement) {
        current = current.parentElement;
      } else {
        const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
        current = root && root.host ? root.host : null;
      }
    }
    return true;
  }

  function hasBoxes(node) {
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getClientRects().length > 0;
    } catch {
      return false;
    }
  }

  // 文本节点没有自己的盒子，按它所在的渲染内容判断；元素节点要求自身有盒子。
  function nodeVisible(node) {
    if (!node) return false;
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element || !styleVisible(element)) return false;
    if (node.nodeType === 3) return hasBoxes(node);
    return element.getClientRects().length > 0;
  }

  function elementVisible(element) {
    return Boolean(element) && element.getClientRects().length > 0 && styleVisible(element);
  }

  function textOf(node) {
    if (!node) return '';
    if (node.nodeType === 3) return String(node.textContent || '').replace(/\s+/g, ' ').trim();
    const value = node.innerText !== undefined ? node.innerText : node.textContent;
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function selectorNames(element) {
    const names = [];
    for (const entry of selectors) {
      if (!entry || !entry.selector) continue;
      try {
        if (element.matches(entry.selector)) names.push(entry.name);
      } catch {
        // 单个无效选择器不该让整次快照失败。
      }
    }
    return names;
  }

  function slotRecord(slot) {
    const assigned = Array.from(slot.assignedNodes());
    const fallback = Array.from(slot.childNodes);
    const assignedVisible = assigned.filter(node => nodeVisible(node));
    const fallbackVisible = fallback.filter(node => nodeVisible(node));
    const describe = node => ({
      node: node.nodeType === 1 ? labelOf(node) : '#text',
      text: textOf(node),
      visible: nodeVisible(node),
      rootPath: rootPathOf(node),
      path: ancestorPathOf(node),
      device: deviceOf(node)
    });

    let renderedFrom = 'none';
    if (assigned.length > 0) {
      if (assignedVisible.length > 0) renderedFrom = 'assigned';
    } else if (fallbackVisible.length > 0) {
      // 后备内容只有在没有分配节点、且确实占据渲染空间时才算页面展示的数据。
      renderedFrom = 'fallback';
    }

    const shown = renderedFrom === 'assigned' ? assignedVisible : fallbackVisible;
    return {
      name: slot.getAttribute('name') || '',
      host: labelOf(slot.getRootNode().host),
      rootPath: rootPathOf(slot),
      device: deviceOf(slot),
      assignedCount: assigned.length,
      assigned: assigned.map(describe),
      fallback: fallback.map(describe),
      renderedFrom,
      text: shown.map(node => textOf(node)).filter(Boolean).join(' ').trim()
    };
  }

  function walk(root, host) {
    if (seen.has(root)) return;
    seen.add(root);
    rootSerial += 1;
    const rootId = `${tokenPrefix}:root:${rootSerial}`;
    roots.push({
      id: rootId,
      host: host ? labelOf(host) : '#document',
      mode: root === document ? 'document' : root.mode || 'unknown',
      rootPath: rootPathOf(host || document)
    });

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let element = walker.nextNode();
    while (element) {
      if (nodes.length + slots.length >= maxNodes) {
        truncated = true;
        return;
      }

      const matches = selectorNames(element);
      const interesting = matches.length > 0 ||
        element.shadowRoot ||
        element.tagName === 'IFRAME' ||
        element.tagName === 'SLOT' ||
        element.hasAttribute('data-device');
      if (interesting) {
        nodes.push({
          root: rootId,
          rootPath: rootPathOf(element),
          path: ancestorPathOf(element),
          tag: element.tagName.toLowerCase(),
          id: element.id || null,
          element: labelOf(element),
          slot: element.getAttribute('slot'),
          matches,
          text: textOf(element).slice(0, 2000),
          visible: elementVisible(element),
          device: deviceOf(element)
        });
      }

      if (element.tagName === 'SLOT') slots.push({ root: rootId, ...slotRecord(element) });

      if (element.tagName === 'IFRAME') {
        tokenSerial += 1;
        const token = `${tokenPrefix}:${tokenSerial}`;
        element.setAttribute(tokenAttribute, token);
        frames.push({
          token,
          root: rootId,
          rootPath: rootPathOf(element),
          path: ancestorPathOf(element),
          src: element.getAttribute('src'),
          title: element.getAttribute('title'),
          visible: elementVisible(element),
          device: deviceOf(element)
        });
      }

      if (element.tagName.includes('-') && !element.shadowRoot) {
        unresolved.push({
          host: labelOf(element),
          root: rootId,
          rootPath: rootPathOf(element),
          path: ancestorPathOf(element),
          reason: 'closed-or-absent-shadow-root',
          note: '没有可访问的开放 shadow root；封闭组件保持边界说明，不读取也不推测其内部字段。'
        });
      }

      if (element.shadowRoot) walk(element.shadowRoot, element);
      element = walker.nextNode();
    }
  }

  walk(document, null);

  return {
    frame: {
      url: location.href,
      origin: location.origin,
      title: document.title,
      readyState: document.readyState
    },
    roots,
    nodes,
    slots,
    frames,
    unresolved,
    truncated,
    collectedAt: Date.now()
  };
}

// 轻量指纹使用与完整快照相同的可见性规则，用来判断两次观察之间页面是否换代。
export function readFingerprint(options) {
  const config = options || {};
  const selectors = Array.isArray(config.selectors) ? config.selectors : [];
  const slotName = config.slotName || 'label';
  const identities = [];
  const fields = [];
  const slots = [];
  const seen = new Set();

  function styleVisible(element) {
    let current = element;
    while (current) {
      const style = getComputedStyle(current);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.contentVisibility === 'hidden' ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
      if (current.parentElement) {
        current = current.parentElement;
      } else {
        const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
        current = root && root.host ? root.host : null;
      }
    }
    return true;
  }

  function hasBoxes(node) {
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getClientRects().length > 0;
    } catch {
      return false;
    }
  }

  function nodeVisible(node) {
    if (!node) return false;
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element || !styleVisible(element)) return false;
    if (node.nodeType === 3) return hasBoxes(node);
    return element.getClientRects().length > 0;
  }

  function elementVisible(element) {
    return Boolean(element) && element.getClientRects().length > 0 && styleVisible(element);
  }

  function textOf(node) {
    if (!node) return '';
    if (node.nodeType === 3) return String(node.textContent || '').replace(/\s+/g, ' ').trim();
    const value = node.innerText !== undefined ? node.innerText : node.textContent;
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function labelOf(node) {
    if (!node || node.nodeType === 9) return '#document';
    const tag = node.tagName ? node.tagName.toLowerCase() : '#node';
    const id = node.id ? '#' + node.id : '';
    const slot = node.getAttribute && node.getAttribute('slot');
    return tag + id + (slot ? '[slot=' + JSON.stringify(slot) + ']' : '');
  }

  function rootPathOf(node) {
    const chain = [];
    let root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    while (root && root.nodeType === 11) {
      chain.unshift({ kind: 'shadow-root', mode: root.mode || 'unknown', host: labelOf(root.host) });
      root = root.host && typeof root.host.getRootNode === 'function' ? root.host.getRootNode() : null;
    }
    return [{ kind: 'document', url: location.href }].concat(chain);
  }

  function ancestorPathOf(node) {
    const path = [];
    let current = node.parentNode;
    while (current) {
      if (current.nodeType === 1) {
        path.push(labelOf(current));
        current = current.parentNode;
      } else if (current.nodeType === 11) {
        path.push('#shadow-root');
        current = current.host;
      } else {
        current = current.parentNode;
      }
    }
    return path.reverse();
  }

  function matches(element) {
    const names = [];
    for (const entry of selectors) {
      if (!entry || !entry.selector) continue;
      try {
        if (element.matches(entry.selector)) names.push(entry.name);
      } catch {
        // 忽略无效选择器。
      }
    }
    return names;
  }

  function walk(root) {
    if (seen.has(root)) return;
    seen.add(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let element = walker.nextNode();
    while (element) {
      if (element.hasAttribute('data-device') || element.hasAttribute('data-generation')) {
        identities.push({
          device: element.getAttribute('data-device'),
          generation: element.getAttribute('data-generation'),
          at: labelOf(element),
          path: ancestorPathOf(element),
          rootPath: rootPathOf(element)
        });
      }
      for (const name of matches(element)) {
        fields.push({ name, text: textOf(element), visible: elementVisible(element) });
      }
      if (element.tagName === 'SLOT' && (element.getAttribute('name') || '') === slotName) {
        const assigned = Array.from(element.assignedNodes());
        const fallback = Array.from(element.childNodes);
        const assignedVisible = assigned.filter(node => nodeVisible(node));
        const fallbackVisible = fallback.filter(node => nodeVisible(node));
        const shown = assigned.length > 0 ? assignedVisible : (fallbackVisible.length > 0 ? fallbackVisible : []);
        slots.push({
          name: slotName,
          assignedCount: assigned.length,
          renderedFrom: assigned.length > 0
            ? (assignedVisible.length > 0 ? 'assigned' : 'none')
            : (fallbackVisible.length > 0 ? 'fallback' : 'none'),
          text: shown.map(node => textOf(node)).filter(Boolean).join(' ').trim()
        });
      }
      if (element.shadowRoot) walk(element.shadowRoot);
      element = walker.nextNode();
    }
  }

  walk(document);
  return { url: location.href, identities, fields, slots };
}

export function probeDocument() {
  const navigation = performance.getEntriesByType('navigation')[0];
  const body = document.body;
  return {
    url: location.href,
    origin: location.origin,
    readyState: document.readyState,
    contentType: document.contentType,
    httpStatus: navigation && typeof navigation.responseStatus === 'number' ? navigation.responseStatus : null,
    bodyPresent: Boolean(body),
    text: body ? String(body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500) : '',
    bodyDevice: body && body.dataset ? body.dataset.device ?? null : null,
    bodyGeneration: body && body.dataset ? body.dataset.generation ?? null : null
  };
}
