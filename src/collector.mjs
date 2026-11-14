// 遍历可访问组合树（主文档 + 开放 shadow root + 已授权 iframe），
// 给每个字段标注它来自哪一层组件、哪个 frame、以及当时的设备身份。
// 每次观察都必须看到同一身份且连续稳定，才写出一条设备记录。
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {snapshotDocument, readFingerprint, probeDocument} from './snapshot.mjs';

export const FRAME_STATUS = Object.freeze({
  READY: 'ready',
  UNLOADED: 'unloaded',
  DENIED: 'denied',
  INVALID: 'invalid',
  ERROR: 'error'
});

export const CATALOG_STATUS = Object.freeze({
  STABLE: 'stable',
  PARTIAL: 'partial',
  UNSETTLED: 'unsettled',
  INCOMPLETE: 'incomplete'
});

// 这些状态不会自行恢复，出现后可以立即收敛，不必等满稳定窗口。
const TERMINAL_FRAME_STATUSES = new Set([FRAME_STATUS.DENIED, FRAME_STATUS.INVALID, FRAME_STATUS.ERROR]);
const BOUNDARY_TEXT = {
  [FRAME_STATUS.DENIED]: '未授权：没有读取该 frame 的任何字段，也没有用其他 frame 的同名字段补位。',
  [FRAME_STATUS.UNLOADED]: '尚未加载：该 frame 的字段缺失，未用其他 frame 的同名字段补位。',
  [FRAME_STATUS.INVALID]: '响应不是可读的授权页面：该 frame 的字段缺失，未用其他 frame 的同名字段补位。',
  [FRAME_STATUS.ERROR]: '不可用：没有读取该 frame 的字段，未用其他 frame 的同名字段补位。'
};

function firstLine(error) {
  return String(error && error.message ? error.message : error).split('\n')[0];
}

function layerOf(rootPath, frame) {
  const shadows = (rootPath || []).filter(part => part.kind === 'shadow-root');
  const local = shadows.length === 0
    ? 'main-document'
    : shadows.map(part => `shadow-root(${part.host})`).join(' > ');
  return frame ? `iframe(${frame.token}) > ${local}` : local;
}

function sortRows(rows) {
  return rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function outlineOf(snapshot) {
  if (!snapshot) return null;
  return {
    fields: sortRows(snapshot.nodes
      .flatMap(node => node.matches.map(name => [name, node.visible ? 1 : 0, node.text]))),
    slots: sortRows(snapshot.slots
      .map(slot => [slot.name, slot.assignedCount, slot.renderedFrom, slot.text]))
  };
}

function fingerprintOutline(fingerprint) {
  return {
    identities: sortRows(fingerprint.identities
      .map(item => [item.at, item.device, item.generation, JSON.stringify(item.rootPath)])),
    fields: sortRows(fingerprint.fields
      .map(item => [item.name, item.visible ? 1 : 0, item.text])),
    slots: sortRows(fingerprint.slots
      .map(item => [item.name, item.assignedCount, item.renderedFrom, item.text]))
  };
}

function classify(probe, snapshotError) {
  if (!probe) return {status: FRAME_STATUS.ERROR, detail: '没有可读的 frame 文档'};
  if (probe.url === 'about:blank') {
    return {status: FRAME_STATUS.UNLOADED, detail: '浏览器尚未提交该 frame 的文档（about:blank）'};
  }
  if (probe.url.startsWith('chrome-error://')) {
    return {status: FRAME_STATUS.ERROR, detail: 'frame 导航失败，没有可用文档'};
  }
  if (!probe.bodyPresent && probe.readyState !== 'complete') {
    return {status: FRAME_STATUS.UNLOADED, detail: `文档尚未就绪（${probe.readyState}）`};
  }
  if (probe.httpStatus === 403) {
    return {status: FRAME_STATUS.DENIED, detail: '来源返回 403：该 frame 未授权'};
  }
  if (typeof probe.httpStatus === 'number' && probe.httpStatus >= 400) {
    return {status: FRAME_STATUS.ERROR, detail: `frame 响应 HTTP ${probe.httpStatus}`};
  }
  if (probe.contentType && probe.contentType !== 'text/html') {
    return {status: FRAME_STATUS.INVALID, detail: `响应不是 HTML（${probe.contentType}），不能当作设备字段`};
  }
  if (probe.origin === 'null' && !probe.url.startsWith('about:')) {
    return {status: FRAME_STATUS.ERROR, detail: 'frame 文档来源不透明（sandbox），内容不可信'};
  }
  if (snapshotError) return {status: FRAME_STATUS.ERROR, detail: snapshotError};
  return {status: FRAME_STATUS.READY, detail: null};
}

async function readDocument(frame, config, tokenPrefix) {
  let probe;
  try {
    probe = await frame.evaluate(probeDocument);
  } catch (error) {
    return {status: FRAME_STATUS.ERROR, detail: firstLine(error), probe: null, snapshot: null};
  }

  let snapshot = null;
  let snapshotError = null;
  try {
    snapshot = await frame.evaluate(snapshotDocument, {
      selectors: config.selectors,
      tokenAttribute: config.tokenAttribute,
      tokenPrefix,
      maxNodes: config.maxNodes
    });
  } catch (error) {
    snapshotError = firstLine(error);
  }

  return {...classify(probe, snapshotError), probe, snapshot};
}

function frameIdentity(probe) {
  if (!probe) return null;
  if (probe.bodyDevice === null && probe.bodyGeneration === null) return null;
  return {device: probe.bodyDevice, generation: probe.bodyGeneration, at: 'frame-document'};
}

function pageIdentity(fingerprint) {
  const chosen = fingerprint.identities.find(item => item.device !== null) || fingerprint.identities[0];
  if (!chosen) return null;
  return {device: chosen.device, generation: chosen.generation, at: chosen.at};
}

function describeIframe(node, attribute) {
  return {
    token: node.getAttribute(attribute),
    src: node.getAttribute('src'),
    title: node.getAttribute('title'),
    visible: node.getClientRects().length > 0
  };
}

// 读取父上下文中的 iframe。token 由父文档快照写进元素属性；子文档以其 token 作为
// 自己的 token 前缀，因此嵌套 frame 的字段来源不会互相混淆。
async function readFrameChildren(context, parentToken, parentSnapshot, config, list, depth, prefixBase) {
  let handles;
  try {
    handles = await context.$$(`iframe[${config.tokenAttribute}]`);
  } catch {
    return;
  }

  const metaByToken = new Map((parentSnapshot?.frames || []).map(item => [item.token, item]));

  for (const handle of handles) {
    let described;
    try {
      described = await handle.evaluate(describeIframe, config.tokenAttribute);
    } catch (error) {
      described = {token: null, src: null, title: null, visible: false, error: firstLine(error)};
    }
    const meta = metaByToken.get(described.token) || null;
    const fallbackToken = `${prefixBase}.${list.length + 1}`;
    const base = {
      // 元素在快照之后才被创建时没有 token；给它一个可回查的临时标识并标记原因。
      token: described.token || fallbackToken,
      tokenFallback: !described.token,
      parentToken,
      src: described.src,
      title: described.title,
      visible: described.visible,
      elementPath: meta?.path ?? null,
      elementRootPath: meta?.rootPath ?? null,
      depth
    };

    const contentFrame = await handle.contentFrame();
    if (!contentFrame) {
      list.push({
        ...base,
        status: FRAME_STATUS.UNLOADED,
        detail: '浏览器尚未提供该 frame 的文档',
        probe: null,
        snapshot: null,
        identity: null
      });
      await handle.dispose();
      continue;
    }

    const tokenPrefix = described.token ? `${described.token}` : fallbackToken;
    const read = await readDocument(contentFrame, config, tokenPrefix);
    const record = {
      ...base,
      status: read.status,
      detail: read.detail,
      probe: read.probe,
      snapshot: read.snapshot,
      identity: frameIdentity(read.probe)
    };
    list.push(record);

    if (read.status === FRAME_STATUS.READY && read.snapshot && depth + 1 < config.maxFrameDepth) {
      await readFrameChildren(contentFrame, described.token, read.snapshot, config, list, depth + 1, tokenPrefix);
    }
    await handle.dispose();
  }
}

// 过渡态：页面身份、frame 身份与字段所在组件身份不一致。
// 典型情形是组件先换了设备编号、120ms 后才换价格。
function detectTransition(observation) {
  if (observation.error) return null;
  const expected = observation.identity
    || observation.frames.find(frame => frame.identity)?.identity
    || null;
  if (!expected) return null;

  const mismatches = [];
  const compare = (source, identity, extra) => {
    if (!identity) return;
    const deviceDiffers = expected.device !== null && identity.device !== null && expected.device !== identity.device;
    const generationDiffers = expected.generation !== null && identity.generation !== null &&
      String(expected.generation) !== String(identity.generation);
    if (deviceDiffers || generationDiffers) {
      mismatches.push({
        source,
        expected: {device: expected.device, generation: expected.generation},
        observed: {device: identity.device, generation: identity.generation},
        ...extra
      });
    }
  };

  for (const frame of observation.frames) {
    if (frame.status !== FRAME_STATUS.READY) continue;
    compare('iframe', frame.identity, {
      token: frame.token,
      url: frame.probe?.url ?? frame.src,
      elementPath: frame.elementPath
    });
  }

  for (const node of observation.main.snapshot.nodes) {
    if (!node.matches || node.matches.length === 0) continue;
    compare(`field:${node.matches.join(',')}`, node.device, {element: node.element});
  }

  return mismatches.length > 0 ? mismatches : null;
}

function signatureOf(observation) {
  if (observation.error) return `error:${observation.error}`;
  return JSON.stringify({
    main: {
      url: observation.main.probe.url,
      readyState: observation.main.probe.readyState,
      fingerprint: fingerprintOutline(observation.main.fingerprint),
      snapshot: outlineOf(observation.main.snapshot)
    },
    frames: observation.frames.map(frame => ({
      token: frame.token,
      parentToken: frame.parentToken,
      src: frame.src,
      status: frame.status,
      url: frame.probe ? frame.probe.url : null,
      identity: frame.identity,
      outline: outlineOf(frame.snapshot)
    }))
  });
}

async function observe(page, config, runId) {
  const mainFrame = page.mainFrame();
  let probe;
  let fingerprint;
  let snapshot;
  try {
    probe = await mainFrame.evaluate(probeDocument);
    fingerprint = await mainFrame.evaluate(readFingerprint, {
      selectors: config.selectors,
      slotName: config.slotName
    });
    snapshot = await mainFrame.evaluate(snapshotDocument, {
      selectors: config.selectors,
      tokenAttribute: config.tokenAttribute,
      tokenPrefix: runId,
      maxNodes: config.maxNodes
    });
  } catch (error) {
    return {error: firstLine(error), main: null, frames: [], identity: null, transition: null};
  }

  const frames = [];
  await readFrameChildren(page, null, snapshot, config, frames, 0, runId);

  const observation = {
    at: Date.now(),
    main: {probe, fingerprint, snapshot},
    frames,
    identity: pageIdentity(fingerprint),
    transition: null
  };
  observation.transition = detectTransition(observation);
  observation.signature = signatureOf(observation);
  return observation;
}

function frameRef(frame) {
  return {
    kind: frame ? 'iframe' : 'main',
    token: frame?.token ?? null,
    url: frame ? frame.probe?.url ?? frame.src ?? null : null,
    status: frame ? frame.status : FRAME_STATUS.READY,
    identity: frame?.identity ?? null
  };
}

function collectFields(observation) {
  const fields = [];

  const addSnapshot = (snapshot, frame) => {
    if (!snapshot) return;

    for (const node of snapshot.nodes) {
      if (!node.matches || node.matches.length === 0) continue;
      const device = node.device
        || (frame && frame.identity
          ? {...frame.identity, origin: 'frame-document', rootPath: node.rootPath, path: node.path}
          : null);
      for (const name of node.matches) {
        fields.push({
          field: name,
          value: node.visible ? node.text : null,
          text: node.text,
          visible: node.visible,
          layer: layerOf(node.rootPath, frame),
          element: node.element,
          rootPath: node.rootPath,
          path: node.path,
          frame: frameRef(frame),
          device
        });
      }
    }

    for (const slot of snapshot.slots) {
      if (slot.renderedFrom === 'none') continue;
      const parts = slot.renderedFrom === 'assigned' ? slot.assigned : slot.fallback;
      for (const part of parts.filter(item => item.visible)) {
        const device = part.device
          || slot.device
          || (frame?.identity ? {...frame.identity, origin: 'frame-document'} : null);
        fields.push({
          field: slot.name,
          value: part.text,
          text: part.text,
          visible: true,
          layer: `slot(${slot.host})`,
          slotFrom: slot.renderedFrom,
          element: slot.host,
          rootPath: part.rootPath,
          path: part.path,
          slotHostRootPath: slot.rootPath,
          frame: frameRef(frame),
          device
        });
      }
    }
  };

  addSnapshot(observation.main.snapshot, null);
  for (const frame of observation.frames) {
    if (frame.status !== FRAME_STATUS.READY) continue;
    addSnapshot(frame.snapshot, frame);
  }
  return fields;
}

function plainFrames(frames) {
  return frames.map(frame => ({
    token: frame.token,
    tokenFallback: frame.tokenFallback,
    parentToken: frame.parentToken,
    depth: frame.depth,
    src: frame.src,
    title: frame.title,
    url: frame.probe?.url ?? null,
    status: frame.status,
    detail: frame.detail,
    httpStatus: frame.probe?.httpStatus ?? null,
    contentType: frame.probe?.contentType ?? null,
    identity: frame.identity,
    elementPath: frame.elementPath,
    elementRootPath: frame.elementRootPath,
    boundary: frame.status === FRAME_STATUS.READY ? null : BOUNDARY_TEXT[frame.status]
  }));
}

function collectUnresolved(observation) {
  const unresolved = [];
  const add = (snapshot, frame) => {
    if (!snapshot) return;
    for (const item of snapshot.unresolved) unresolved.push({...item, frame: frameRef(frame)});
  };
  add(observation.main.snapshot, null);
  for (const frame of observation.frames) {
    if (frame.status === FRAME_STATUS.READY) add(frame.snapshot, frame);
  }
  return unresolved;
}

function collectLayers(observation) {
  const layers = [{source: 'main', token: null, status: FRAME_STATUS.READY, roots: observation.main.snapshot.roots}];
  for (const frame of observation.frames) {
    layers.push({
      source: 'iframe',
      token: frame.token,
      status: frame.status,
      roots: frame.snapshot ? frame.snapshot.roots : []
    });
  }
  return layers;
}

// 同名字段出现在多个 frame 时，不合并成一个值，只报告歧义。
function fieldAmbiguities(fields) {
  const groups = new Map();
  for (const field of fields) {
    if (!groups.has(field.field)) groups.set(field.field, []);
    groups.get(field.field).push(field);
  }
  const ambiguities = [];
  for (const [name, entries] of groups) {
    const frames = [...new Set(entries.map(entry => entry.frame.token ?? entry.frame.kind))];
    if (frames.length > 1) {
      ambiguities.push({
        kind: 'field-ambiguous',
        field: name,
        frames,
        detail: `字段“${name}”同时出现在多个 frame 中；目录按 frame 分别保留，未合并成一个值。`
      });
    }
  }
  return ambiguities;
}

function traceOf(observations, start) {
  return observations.map(observation => ({
    at: observation.at - start,
    error: observation.error ?? null,
    identity: observation.identity,
    transition: observation.transition,
    frames: observation.error
      ? []
      : observation.frames.map(frame => ({
          token: frame.token,
          parentToken: frame.parentToken,
          status: frame.status,
          url: frame.probe?.url ?? null,
          identity: frame.identity
        })),
    fields: observation.error
      ? []
      : collectFields(observation).map(field => ({
          field: field.field,
          value: field.value,
          layer: field.layer,
          frame: field.frame.token ?? field.frame.kind,
          device: field.device
            ? {device: field.device.device, generation: field.device.generation}
            : null
        }))
  }));
}

export async function collectCatalog(page, options = {}) {
  const settleTimeout = options.settleTimeout ?? 5000;
  const config = {
    selectors: options.selectors || [
      {name: 'power', selector: '#power'},
      {name: 'price', selector: '#price'}
    ],
    slotName: options.slotName || 'label',
    tokenAttribute: 'data-catalog-frame',
    settleTimeout,
    frameTimeout: options.frameTimeout ?? Math.min(settleTimeout, 2500),
    pollInterval: options.pollInterval ?? 120,
    requiredStable: options.requiredStable ?? 3,
    maxFrameDepth: options.maxFrameDepth ?? 2,
    maxObservations: options.maxObservations ?? 80,
    maxNodes: options.maxNodes ?? 8000
  };

  const runId = `run-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const observations = [];
  const warnings = [];
  let stableCount = 0;
  let previousSignature = null;
  let settled = false;
  let frameWaitExpired = false;

  while (observations.length < config.maxObservations) {
    const observation = await observe(page, config, runId);
    observations.push(observation);

    if (observation.error) {
      warnings.push({kind: 'page-unreadable', detail: observation.error});
      break;
    }

    if (observation.signature === previousSignature) stableCount += 1;
    else stableCount = 1;
    previousSignature = observation.signature;

    const allReady = observation.frames.every(frame => frame.status === FRAME_STATUS.READY);
    const pending = observation.frames.filter(frame => frame.status === FRAME_STATUS.UNLOADED);
    const terminalOnly = observation.frames
      .filter(frame => frame.status !== FRAME_STATUS.READY)
      .every(frame => TERMINAL_FRAME_STATUSES.has(frame.status));

    if (stableCount >= config.requiredStable && !observation.transition) {
      if (allReady || terminalOnly) {
        settled = true;
        break;
      }
      // 未加载的 frame 等待有上限；到点后按明确的未完成结果收敛。
      if (pending.length > 0 && Date.now() - startedAt >= config.frameTimeout) {
        settled = true;
        frameWaitExpired = true;
        break;
      }
    }

    if (Date.now() - startedAt >= config.settleTimeout) {
      frameWaitExpired = pending.length > 0;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, config.pollInterval));
  }

  const finalObservation = observations.at(-1) || null;
  const elapsed = Date.now() - startedAt;
  const base = {
    pageUrl: page.url(),
    generatedAt: new Date().toISOString(),
    elapsed,
    observationCount: observations.length,
    warnings
  };

  if (!finalObservation || finalObservation.error) {
    warnings.push({
      kind: 'page-unreadable',
      detail: finalObservation?.error ?? '没有取得任何页面观察'
    });
    return {
      ...base,
      status: CATALOG_STATUS.INCOMPLETE,
      complete: false,
      identity: null,
      record: null,
      fields: [],
      frames: [],
      layers: [],
      unresolved: [],
      truncated: false,
      warnings,
      trace: traceOf(observations, startedAt)
    };
  }

  const notReady = finalObservation.frames.filter(frame => frame.status !== FRAME_STATUS.READY);
  for (const frame of notReady) {
    warnings.push({
      kind: 'frame-not-ready',
      token: frame.token,
      status: frame.status,
      detail: frame.detail,
      src: frame.src ?? null
    });
  }
  if (finalObservation.transition) {
    warnings.push({kind: 'transition-detected', detail: finalObservation.transition});
  }
  if (frameWaitExpired) {
    warnings.push({
      kind: 'frame-load-timeout',
      detail: `frame 在 ${config.frameTimeout}ms 内仍未加载完成；已停止等待并按边界说明保留结果。`
    });
  }
  if (!settled && !frameWaitExpired && !finalObservation.transition) {
    warnings.push({
      kind: 'settle-timeout',
      detail: `在 ${config.settleTimeout}ms 内没有连续 ${config.requiredStable} 次一致的展示状态`
    });
  }
  if (notReady.length === 0 && finalObservation.identity) {
    for (const frame of finalObservation.frames) {
      if (frame.status === FRAME_STATUS.READY && !frame.identity) {
        warnings.push({
          kind: 'frame-identity-missing',
          token: frame.token,
          detail: '该 frame 的文档没有提供 data-device/data-generation；其字段无法与页面身份对齐。'
        });
      }
    }
  }

  const fields = collectFields(finalObservation);
  warnings.push(...fieldAmbiguities(fields));

  let status;
  if (finalObservation.transition) {
    // 身份或价格仍在换代：不写设备记录，只给出过渡观察。
    status = CATALOG_STATUS.UNSETTLED;
  } else if (!settled) {
    status = CATALOG_STATUS.INCOMPLETE;
  } else if (notReady.some(frame => frame.status === FRAME_STATUS.UNLOADED)) {
    // 还停在未加载的 frame 意味着字段缺失；这是明确的未完成结果，不是一条设备记录。
    status = CATALOG_STATUS.INCOMPLETE;
  } else if (notReady.length > 0) {
    // 未授权/无效/损坏的 frame 是稳定边界，可把可访问部分写成不完整的目录记录。
    status = CATALOG_STATUS.PARTIAL;
  } else if (fields.every(field => field.device !== null)) {
    status = CATALOG_STATUS.STABLE;
  } else {
    status = CATALOG_STATUS.PARTIAL;
  }

  const identity = finalObservation.identity
    || finalObservation.frames.find(frame => frame.identity)?.identity
    || null;
  const frames = plainFrames(finalObservation.frames);
  const layers = collectLayers(finalObservation);
  const unresolved = collectUnresolved(finalObservation);
  const truncated = Boolean(
    finalObservation.main.snapshot?.truncated ||
    finalObservation.frames.some(frame => frame.snapshot?.truncated)
  );

  const canWriteRecord = status === CATALOG_STATUS.STABLE || status === CATALOG_STATUS.PARTIAL;
  const record = canWriteRecord
    ? {
        pageUrl: page.url(),
        generatedAt: new Date().toISOString(),
        status,
        complete: status === CATALOG_STATUS.STABLE,
        identity,
        fields,
        frames,
        layers,
        unresolved,
        truncated
      }
    : null;

  return {
    ...base,
    warnings,
    status,
    complete: status === CATALOG_STATUS.STABLE,
    identity,
    record,
    // 没有写成设备记录时，字段只保留在 trace 里作为诊断；顶层目录不给出可误用的值。
    fields: record ? fields : [],
    frames,
    layers,
    unresolved,
    truncated,
    trace: traceOf(observations, startedAt)
  };
}

// 把采集结果写成可回查来源的目录文件；没有设备记录时仍写出带边界说明的结果。
export async function writeCatalog(catalog, directory) {
  await mkdir(directory, {recursive: true});
  const payload = {
    schema: 'composed-catalog/1',
    pageUrl: catalog.pageUrl,
    generatedAt: catalog.generatedAt,
    status: catalog.status,
    complete: catalog.complete,
    identity: catalog.identity,
    fields: catalog.fields,
    frames: catalog.frames,
    layers: catalog.layers,
    unresolved: catalog.unresolved,
    truncated: catalog.truncated,
    warnings: catalog.warnings,
    trace: catalog.trace,
    ...(catalog.record ? {} : {
      note: '没有写出设备记录：页面没有给出在稳定观察下同时成立的身份与字段。'
    })
  };
  const path = join(directory, 'catalog.json');
  await writeFile(path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return path;
}
