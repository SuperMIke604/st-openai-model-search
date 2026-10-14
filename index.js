/**
 * OpenAI Model Search (select2)
 *
 * 给酒馆两处下拉补上 SillyTavern 已内置的 select2，从而拿到搜索框：
 *   1. #model_openai_select —— Chat Completion 的「OpenAI Model」下拉（单选）
 *   2. .character_extra_world_info_selector —— 角色/世界书弹窗里的
 *      「辅助 Lorebook」下拉（多选，宿主只在 PC 挂，这里补移动端）
 *
 * 背景：
 * - 上游 public/scripts/openai.js 给 OpenRouter / Aimlapi / ElectronHub /
 *   Chutes / NanoGPT 五个模型下拉都挂了 select2（有搜索框），唯独漏了 OpenAI 这个。
 * - 宿主 script.js:9607 给「辅助 Lorebook」挂 select2 时写在 if (!isMobile()) 里，
 *   所以 PC 有搜索、移动端没有。
 *
 * 两处都走 select2（不用自定义弹窗）—— 与官方那五个下拉保持完全一致的观感与交互。
 * 本扩展不改动任何核心文件。
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

/** 目标下拉一（review/index.html:3068 的原生 <select>，单选） */
const SELECT_SELECTOR = /** @type {const} */ ('#model_openai_select');

/** 目标下拉二（index.html:6771 的原生 <select multiple>，辅助 Lorebook） */
const EXTRAS_SELECT_SELECTOR = /** @type {const} */ ('.character_extra_world_info_selector');

/** select2 接管后会给原 select 加这个类，用于幂等判断 */
const SELECT2_CLASS = /** @type {const} */ ('select2-hidden-accessible');

/** 静态模板容器：模板里的同款 select 不可挂载（它会被 clone 进真实弹窗） */
const TEMPLATE_HOLDER_CLASS = /** @type {const} */ ('template_element');

/** 弹窗根节点：用它作为 dropdownParent，避免下拉被弹窗裁切 */
const POPUP_SELECTOR = /** @type {const} */ ('dialog.popup');

/**
 * 触摸设备是否启用。
 *
 * 官方 openai.js 对这类下拉是 `if (!isMobile())` 才挂 select2（移动端保持原生滚轮）。
 * 但模型列表越来越长，手机上翻找更痛苦，所以本扩展默认在移动端也启用搜索。
 * 如需恢复官方行为（移动端保持原生滚轮选择器），把这里改成 false 即可。
 */
const ENABLE_ON_TOUCH = /** @type {const} */ (true);

// ===== 文案（中英双语，不依赖 i18n 词条是否存在） =====
const SEARCH_PLACEHOLDER = /** @type {const} */ ('搜索模型… (Search models...)');
const EXTRAS_SEARCH_PLACEHOLDER = /** @type {const} */ ('搜索世界书… (Search Lorebooks...)');
const EXTRAS_PLACEHOLDER = /** @type {const} */ ('未设置辅助 Lorebook，点此选择… (No auxiliary Lorebooks set...)');

/** 宿主输入框样式类，让搜索框外观与其它输入框一致 */
const SEARCH_INPUT_CLASS = /** @type {const} */ ('text_pole');

/** APP_READY 重试上限（扩展是 async 加载的，偶发 DOM 未就绪） */
const MAX_RETRIES = /** @type {const} */ (10);

/** 弹窗内下拉的挂载防抖间隔（弹窗渲染是批量的，等这一批结束再处理） */
const EXTRAS_DEBOUNCE = /** @type {const} */ (150);

/** @type {MutationObserver|null} */
let observer = null;
/** @type {MutationObserver|null} */
let extrasObserver = null;
/** @type {number} */
let retryTimer = 0;
/** @type {number} */
let extrasTimer = 0;
let retryCount = 0;
/** 模型列表指纹：用于判断 option 是否真的被重建 */
let signature = '';
/** 防重入：挂载过程本身会改 DOM，会再次触发 MutationObserver */
let extrasBusy = false;

/**
 * 是否为触摸设备（不引入其它模块，减少依赖面）。
 *
 * 主判据是「无 hover + 粗指针」，覆盖真实手机/平板。
 * 补位判据额外要求「窄窗口且不是精确指针设备」——Windows 触屏笔记本
 * navigator.maxTouchPoints 也大于 0，若不排除，桌面浏览器窗口一拖窄就会被
 * 判成移动端，进而被 ENABLE_ON_TOUCH=false 的早退逻辑跳过（白丢搜索）。
 *
 * @returns {boolean}
 */
function isTouchDevice() {
    if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
        return true;
    }

    if (!(navigator.maxTouchPoints > 0 && window.innerWidth <= 1000)) {
        return false;
    }

    // 精确指针（鼠标/触控板）设备按桌面处理
    return !window.matchMedia('(hover: hover) and (pointer: fine)').matches;
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
 *
 * 之所以要自己做：searchInputPlaceholder / searchInputCssClass 这两个选项
 * 依赖宿主自带的 public/lib/select2-search-placeholder.js 补丁脚本，
 * 本扩展不假设该脚本一定存在，因此自带一份兜底实现（重复设置无副作用）。
 *
 * @param {string} placeholder 占位符文本
 * @param {JQuery|null} $scope 搜索框的查找范围；null 表示全局查找。
 *   弹窗里的下拉必须限定范围，否则会把装饰写到别的 select2 实例上。
 */
function decorateSearchField(placeholder, $scope) {
    const $input = ($scope && $scope.length) ? $scope.find('.select2-search__field') : $('.select2-search__field');

    if ($input.length === 0) {
        return;
    }

    $input.attr('placeholder', placeholder);

    if (SEARCH_INPUT_CLASS) {
        $input.addClass(SEARCH_INPUT_CLASS);
    }
}

/**
 * 给模型下拉挂 select2。幂等：已挂过则只刷新指纹。
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
    $select.on('select2:open', () => decorateSearchField(SEARCH_PLACEHOLDER, null));

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

/**
 * 判断一个「辅助 Lorebook」下拉当前是否适合挂 select2。
 *
 * 两个必须排除的情况：
 * - 位于 .template_element 里的静态模板：宿主 script.js:9563 会把它 clone 进弹窗，
 *   若先给模板挂了 select2，clone 出来的 select 会带上 select2-hidden-accessible
 *   却没有真正的 select2 容器 → 永久失去搜索。
 * - 尚未渲染（弹窗还没打开）：此时挂载会算出错误的宽度。
 *
 * @param {JQuery<HTMLSelectElement>} $select
 * @returns {boolean}
 */
function isExtrasAttachable($select) {
    if ($select.closest(`.${TEMPLATE_HOLDER_CLASS}`).length > 0) {
        return false;
    }

    const el = $select.get(0);

    if (!el || !el.isConnected) {
        return false;
    }

    return $select.is(':visible');
}

/**
 * 给「辅助 Lorebook」下拉挂 select2（PC 与移动端都挂）。
 *
 * 刻意沿用宿主 script.js:9608 的配置风格：
 * - 不改 multiple：多选框挂 select2 后仍是多选
 * - closeOnSelect: false：多选要能连续勾选
 * - dropdownParent: 最近的 dialog.popup，避免下拉被弹窗裁切
 *
 * @returns {number} 本次新挂载的数量
 */
function attachExtrasSelect2() {
    if (!ENABLE_ON_TOUCH) {
        return 0;
    }

    // 已挂过的一律不再挂（幂等）。但宿主那套配置没有中文占位符，
    // 顺手补一个 select2:open 装饰 —— 只补一次，用 data 标记防重复绑定。
    $(EXTRAS_SELECT_SELECTOR).filter(`.${SELECT2_CLASS}`).each((i, el) => {
        const $done = $(el);

        if ($done.data('omsDecorated')) {
            return;
        }

        $done.data('omsDecorated', true);
        const $owner = $done.closest(POPUP_SELECTOR);
        const $ownerScope = $owner.length > 0 ? $owner : $(document.body);
        $done.on('select2:open.oms', () => decorateSearchField(EXTRAS_SEARCH_PLACEHOLDER, $ownerScope));
    });

    const $targets = $(EXTRAS_SELECT_SELECTOR)
        .not(`.${SELECT2_CLASS}`)
        .filter((i, el) => isExtrasAttachable($(el)));

    if ($targets.length === 0) {
        return 0;
    }

    let attached = 0;

    $targets.each((i, el) => {
        const $select = $(el);
        const $popup = $select.closest(POPUP_SELECTOR);
        const options = /** @type {Object} */ ({
            width: '100%',
            placeholder: EXTRAS_PLACEHOLDER,
            searchInputPlaceholder: EXTRAS_SEARCH_PLACEHOLDER,
            searchInputCssClass: SEARCH_INPUT_CLASS,
            allowClear: true,
            closeOnSelect: false,
        });

        if ($popup.length > 0) {
            options.dropdownParent = $popup;
        }

        try {
            $select.select2(options);
        } catch (err) {
            console.warn('[OpenAI Model Search] 辅助 Lorebook 挂载失败，跳过', err);
            return;
        }

        const $scope = $popup.length > 0 ? $popup : $(document.body);
        $select.on('select2:open', () => decorateSearchField(EXTRAS_SEARCH_PLACEHOLDER, $scope));

        attached++;
    });

    if (attached > 0) {
        console.log(`[OpenAI Model Search] 已给 ${attached} 个辅助 Lorebook 下拉挂上 select2（保持多选）`);
    }

    return attached;
}

/** 防抖版挂载入口：MutationObserver 的回调统一走这里 */
function scheduleExtrasAttach() {
    clearTimeout(extrasTimer);
    extrasTimer = window.setTimeout(() => {
        if (extrasBusy) {
            return;
        }
        extrasBusy = true;
        try {
            attachExtrasSelect2();
        } finally {
            extrasBusy = false;
        }
    }, EXTRAS_DEBOUNCE);
}

/**
 * 监听「辅助 Lorebook」下拉的出现。
 *
 * 它是动态创建的：script.js 从模板 clone 出弹窗，onOpen 时配置，弹窗关闭后 DOM 被移除，
 * 下次打开是一个全新的元素 —— 所以必须持续监听，而不是挂一次就完事。
 * 同时监听 dialog 的 open/class 变化，覆盖「元素已在 DOM 但弹窗稍后才打开」的情况。
 */
function watchExtrasSelect() {
    if (extrasObserver || typeof MutationObserver === 'undefined') {
        return;
    }

    extrasObserver = new MutationObserver(scheduleExtrasAttach);

    extrasObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['open', 'class'],
    });

    // 首轮先扫一遍（扩展加载时弹窗可能已经开着）
    scheduleExtrasAttach();
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
 * 入口：先尝试挂载模型下拉；辅助 Lorebook 是动态元素，独立启动监听。
 */
function init() {
    if (!ENABLE_ON_TOUCH && isTouchDevice()) {
        console.log('[OpenAI Model Search] 触摸设备，保持原生选择器');
        return;
    }

    // 辅助 Lorebook 与模型下拉是否就绪无关，独立启动监听
    watchExtrasSelect();

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
