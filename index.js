/**
 * OpenAI Model Search (select2)
 *
 * 给 #model_openai_select（Chat Completion 的「OpenAI Model」下拉）挂上
 * SillyTavern 已内置的 select2，从而拿到搜索框。
 *
 * 背景：上游 public/scripts/openai.js 给 OpenRouter / Aimlapi / ElectronHub /
 * Chutes / NanoGPT 五个模型下拉都挂了 select2（有搜索框），唯独漏了 OpenAI 这个。
 * 本扩展只补上这一处，不改动任何核心文件。
 *
 * 为什么必须是扩展：主题 JSON 只能注入 CSS —— power-user.js 的
 * applyCustomCSS() 只是往 <head> 末尾的 <style id="custom-style"> 里写
 * innerHTML，无法执行 JavaScript。
 *
 * 安装：把本文件夹整体放到
 *   <SillyTavern>/public/scripts/extensions/third-party/st-openai-model-search/
 * 然后在酒馆「扩展」面板启用并刷新页面。
 */

import { eventSource, event_types } from '../../../../script.js';

/** 目标下拉（review/index.html:3068 的原生 <select>） */
const SELECT_SELECTOR = /** @type {const} */ ('#model_openai_select');

/** select2 接管后会给原 select 加这个类，用于幂等判断 */
const SELECT2_CLASS = /** @type {const} */ ('select2-hidden-accessible');

/**
 * 触摸设备是否启用。
 *
 * 官方 openai.js 对这类下拉是 `if (!isMobile())` 才挂 select2（移动端保持原生滚轮）。
 * 但模型列表越来越长，手机上翻找更痛苦，所以本扩展默认在移动端也启用搜索。
 * 如需恢复官方行为（移动端保持原生滚轮选择器），把这里改成 false 即可。
 */
const ENABLE_ON_TOUCH = /** @type {const} */ (true);

/** 搜索框占位符（中英双语，不依赖 i18n 词条是否存在） */
const SEARCH_PLACEHOLDER = /** @type {const} */ ('搜索模型… (Search models...)');

/** 宿主输入框样式类，让搜索框外观与其它输入框一致 */
const SEARCH_INPUT_CLASS = /** @type {const} */ ('text_pole');

/** APP_READY 重试上限与间隔（扩展是 async 加载的，偶发 DOM 未就绪） */
const MAX_RETRIES = /** @type {const} */ (10);
const RETRY_DELAY = /** @type {const} */ (500);

/** @type {MutationObserver|null} */
let observer = null;
/** @type {number} */
let retryTimer = 0;
let retryCount = 0;
/** 模型列表指纹：用于判断 option 是否真的被重建 */
let signature = '';

/**
 * 是否为触摸设备（不引入其它模块，减少依赖面）。
 * @returns {boolean}
 */
function isTouchDevice() {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

/**
 * 计算模型列表指纹。
 * @param {JQuery<HTMLSelectElement>} $select
 * @returns {string}
 */
function optionSignature($select) {
    return $select.find('option').toArray().map((o) => o.value).join('|');
}

/**
 * 每次展开下拉时，给搜索框补上占位符与输入框样式类。
 * 之所以要自己做：searchInputPlaceholder / searchInputCssClass 这两个选项
 * 依赖宿主自带的 public/lib/select2-search-placeholder.js 补丁脚本，
 * 本扩展不假设该脚本一定存在，因此自带一份兜底实现（重复设置无副作用）。
 */
function decorateSearchField() {
    const $input = $('.select2-search__field');
    if ($input.length === 0) {
        return;
    }
    $input.attr('placeholder', SEARCH_PLACEHOLDER);
    if (SEARCH_INPUT_CLASS) {
        $input.addClass(SEARCH_INPUT_CLASS);
    }
}

/**
 * 给目标下拉挂 select2。幂等：已挂过则只刷新指纹。
 * @returns {boolean} true 表示元素已就绪
 */
function attachSelect2() {
    const $select = $(SELECT_SELECTOR);

    if ($select.length === 0) {
        return false;
    }

    if ($select.hasClass(SELECT2_CLASS)) {
        signature = optionSignature($select);
        return true;
    }

    $select.select2({
        width: '100%',
        placeholder: 'Select a model',
        searchInputPlaceholder: SEARCH_PLACEHOLDER,
        searchInputCssClass: SEARCH_INPUT_CLASS,
        closeOnSelect: true,
    });

    // select2 每次展开都会重建下拉 DOM，所以每次 open 都要重新装饰
    $select.on('select2:open', decorateSearchField);

    signature = optionSignature($select);
    console.log('[OpenAI Model Search] select2 已挂载到 #model_openai_select');
    return true;
}

/**
 * 模型列表被重建时重新挂载（切换 API / 刷新模型列表会重建 option）。
 * 只在指纹真的变化时才动作，避免 select2 自身 DOM 操作引起的抖动。
 */
function reattachIfChanged() {
    const $select = $(SELECT_SELECTOR);

    if ($select.length === 0) {
        return;
    }

    if (optionSignature($select) === signature) {
        return;
    }

    if ($select.hasClass(SELECT2_CLASS)) {
        $select.select2('destroy');
    }

    attachSelect2();
}

/** 监听原生 select 的 option 变化（含 External 分组运行期动态追加） */
function watchOptions() {
    const select = document.querySelector(SELECT_SELECTOR);

    if (!select || observer) {
        return;
    }

    observer = new MutationObserver(() => {
        // 防抖：External 分组通常逐个 append，等这一批结束再处理
        clearTimeout(retryTimer);
        retryTimer = window.setTimeout(reattachIfChanged, 100);
    });

    observer.observe(select, { childList: true, subtree: true });
}

/**
 * 入口：先尝试挂载；元素未就绪则在 APP_READY 时重试。
 */
function init() {
    if (!ENABLE_ON_TOUCH && isTouchDevice()) {
        console.log('[OpenAI Model Search] 触摸设备，保持原生选择器');
        return;
    }

    if (attachSelect2()) {
        watchOptions();
        return;
    }

    if (retryCount >= MAX_RETRIES) {
        console.warn('[OpenAI Model Search] 未找到 #model_openai_select，放弃挂载');
        return;
    }

    retryCount++;
    eventSource.on(event_types.APP_READY, init);
}

init();
