import { isFirefox } from '#/common/ua';
import { getUniqId, sendMessage } from '#/common';
import { INJECT_PAGE, INJECT_CONTENT, INJECT_AUTO } from '#/common/consts';
import { attachFunction } from '../utils';
import bridge from './bridge';
import {
  forEach, join, jsonDump, setJsonDump, append, createElement,
} from '../utils/helpers';

// Firefox bug: https://bugzilla.mozilla.org/show_bug.cgi?id=1408996
const VMInitInjection = window[process.env.INIT_FUNC_NAME];
delete window[process.env.INIT_FUNC_NAME];

const { remove } = Element.prototype;

bridge.addHandlers({
  Inject: injectScript,
  InjectMulti: data => data::forEach(injectScript),
});

export function triageScripts(data) {
  const scriptLists = {
    [INJECT_PAGE]: [],
    [INJECT_CONTENT]: [],
  };
  if (data.scripts) {
    data.scripts = data.scripts.filter((script) => {
      bridge.ids.push(script.props.id);
      if ((window.top === window || !script.meta.noframes) && script.config.enabled) {
        bridge.enabledIds.push(script.props.id);
        return true;
      }
      return false;
    });
    let support;
    data.scripts.forEach((script) => {
      let injectInto = script.custom.injectInto || script.meta.injectInto || data.injectInto;
      if (injectInto === INJECT_AUTO) {
        if (!support) support = { injectable: checkInjectable() };
        injectInto = support.injectable ? INJECT_PAGE : INJECT_CONTENT;
      }
      const list = scriptLists[injectInto];
      if (list) list.push(script);
    });
  }
  return scriptLists;
}

export function injectScripts(contentId, webId, data, scriptLists) {
  const props = [];
  // combining directly to avoid GC due to a big intermediate object
  const addUniqProp = key => !props.includes(key) && props.push(key);
  // some browsers may list duplicate props within one window object!
  [window, global].forEach(wnd => Object.getOwnPropertyNames(wnd).forEach(addUniqProp));
  const args = [
    webId,
    contentId,
    props,
    isFirefox,
  ];
  bridge.post.asString = isFirefox;

  const injectPage = scriptLists[INJECT_PAGE];
  const injectContent = scriptLists[INJECT_CONTENT];
  if (injectContent.length) {
    const invokeGuest = VMInitInjection()(...args, bridge.onHandle);
    const postViaBridge = bridge.post;
    bridge.invokableIds.push(...injectContent.map(script => script.props.id));
    bridge.post = msg => (
      msg.realm === INJECT_CONTENT
        ? invokeGuest(msg)
        : postViaBridge(msg)
    );
    bridge.post({
      cmd: 'LoadScripts',
      data: {
        ...data,
        mode: INJECT_CONTENT,
        scripts: injectContent,
      },
      realm: INJECT_CONTENT,
    });
  }
  if (injectPage.length) {
    // Avoid using Function::apply in case it is shimmed
    inject(`(${VMInitInjection}())(${jsonDump(args).slice(1, -1)})`);
    bridge.post({
      cmd: 'LoadScripts',
      data: {
        ...data,
        mode: INJECT_PAGE,
        scripts: injectPage,
      },
    });
  }
  if (injectContent.length) {
    // content script userscripts will run in one of the next event loop cycles
    // (we use browser.tabs.executeScript) so we need to switch to jsonDumpSafe because
    // after this point we can't rely on JSON.stringify anymore, see the notes for setJsonDump
    setJsonDump({ native: false });
  }
}

function checkInjectable() {
  // Check default namespace, `a.style` only exists in HTML namespace
  if (!('style' in document.createElement('a'))) return false;
  const id = getUniqId('VM-');
  const detect = (domId) => {
    const a = document.createElement('a');
    a.id = domId;
    document.documentElement.appendChild(a);
  };
  inject(`(${detect})(${jsonDump(id)})`);
  const a = document.querySelector(`#${id}`);
  const injectable = !!a;
  if (a) a.remove();
  return injectable;
}

const injectedScriptIntro = `(${
  (attach, id, cb, callbackId) => {
    attach(id, cb);
    const callback = window[callbackId];
    if (callback) callback();
  }
})(${attachFunction},`;

function injectScript(data) {
  const [vId, codeSlices, vCallbackId, mode, scriptId] = data;
  // trying to avoid string concatenation of potentially huge code slices as long as possible
  const injectedCode = [
    injectedScriptIntro,
    `"${vId}",`,
    ...codeSlices,
    `,"${vCallbackId}");`,
  ];
  if (mode === INJECT_CONTENT) {
    sendMessage({
      cmd: 'InjectScript',
      data: injectedCode::join(''),
    });
  } else {
    inject(injectedCode, browser.extension.getURL(`/options/index.html#scripts/${scriptId}`));
  }
}

function inject(code, sourceUrl) {
  const script = document::createElement('script');
  // avoid string concatenation of |code| as it can be extremely long
  script::append(
    'document.currentScript.remove();',
    ...typeof code === 'string' ? [code] : code,
    ...sourceUrl ? ['\n//# sourceURL=', sourceUrl] : [],
  );
  document.documentElement::append(script);
  script::remove();
}
