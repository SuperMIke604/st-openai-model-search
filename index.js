/**
 * OpenAI Model Search —— 给酒馆两处下拉补上搜索能力
 *
 * 两处目标：
 *   1. #model_openai_select —— Chat Completion 的「OpenAI Model」下拉（单选）
 *   2. .character_extra_world_info_selector —— 角色/世界书弹窗里的
 *      「辅助 Lorebook」下拉（多选）
 *
 * 背景：
 * - 上游 public/scripts/openai.js 给 OpenRouter / Aimlapi / ElectronHub /
 *   Chutes / NanoGPT 五个模型下拉都挂了 select2（有搜索框），唯独漏了 OpenAI 这个。
 * - 宿主 script.js:9607 给「辅助 Lorebook」挂 select2 时写在 if (!isMobile()) 里，
 *   所以 PC 有搜索、移动端没有。
 *
 * 两条路径：
 * - 桌面端：挂宿主内置的 select2（与 OpenRouter 等下拉完全一致的做法）。
 * - 移动端：select2 的浮层在手机上偏小，改用**自定义全屏弹窗选择器**——
 *   搜索框 + 可滚动列表 + 底部按钮，触摸目标更大，体验接近原生选择器。
 *
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
 * 移动端是否接管这两处下拉。
 * 改成 false 则恢复官方行为（移动端保持原生滚轮选择器）。
 */
const ENABLE_ON_TOUCH = /** @type {const} */ (true);

/**
 * 移动端是否改用「自定义弹窗选择器」代替 select2 浮层。
 * true（默认）：手机上弹出全屏搜索页，触摸目标更大；
 * false：手机上也用 select2 浮层（体积小，但浮层偏小）。
 */
const USE_PICKER_ON_TOUCH = /** @type {const} */ (true);

// ===== 文案（中英双语，不依赖 i18n 词条是否存在） =====
const SEARCH_PLACEHOLDER = /** @type {const} */ ('搜索模型… (Search models...)');
const EXTRAS_SEARCH_PLACEHOLDER = /** @type {const} */ ('搜索世界书… (Search Lorebooks...)');
const EXTRAS_PLACEHOLDER = /** @type {const} */ ('未设置辅助 Lorebook，点此选择… (No auxiliary Lorebooks set...)');
const MODEL_PICKER_TITLE = /** @type {const} */ ('选择模型');
const LOREBOOK_PICKER_TITLE = /** @type {const} */ ('选择辅助 Lorebook');
const PICKER_CANCEL = /** @type {const} */ ('取消');
const PICKER_CONFIRM = /** @type {const} */ ('确定');
const PICKER_EMPTY = /** @type {const} */ ('没有匹配项');

/** 宿主输入框样式类，让搜索框外观与其它输入框一致 */
const SEARCH_INPUT_CLASS = /** @type {const} */ ('text_pole');

/** 本扩展自己挂的 class（样式见同目录 style.css） */
const NATIVE_HIDDEN_CLASS = /** @type {const} */ ('oms-native-hidden');
const TRIGGER_CLASS = /** @type {const} */ ('oms-picker-trigger');
const PICKER_CLASS = /** @type {const} */ ('oms-picker');
const LIST_CLASS = /** @type {const} */ ('oms-picker-list');
const ITEM_CLASS = /** @type {const} */ ('oms-picker-item');
const GROUP_CLASS = /** @type {const} */ ('oms-picker-group');
const EMPTY_CLASS = /** @type {const} */ ('oms-picker-empty');

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

// ==========================================================================
// 一、设备判定
// ==========================================================================

/**
 * 是否为触摸设备（不引入其它模块，减少依赖面）。
 *
 * 主判据是「无 hover + 粗指针」，覆盖真实手机/平板。
 *
 * 补位判据要同时满足三条：有触摸点、窄窗口（<=1000px，与宿主移动端断点一致）、
 * 且**不是**「hover:hover + pointer:fine」。最后这条是必须的——Windows 触屏笔记本
 * navigator.maxTouchPoints 也大于 0，若只看前两条，桌面浏览器窗口一拖窄就会被判成
 * 移动端，于是桌面走弹窗、而宿主又按桌面自己挂了 select2，两套 UI 同时出现。
 * 排除掉精确指针设备后，补位就只剩 iPad 外接键鼠这类「触屏为主 + 偶有精确指针」的情形。
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

    // 精确指针（鼠标/触控板）设备按桌面处理：宿主会自己挂 select2，不抢
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

// ==========================================================================
// 二、桌面端：挂宿主内置的 select2
// ==========================================================================

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
 * 给「辅助 Lorebook」下拉挂 select2（仅 PC；移动端改走自定义弹窗）。
 *
 * 刻意沿用宿主 script.js:9608 的配置风格：
 * - 不改 multiple：多选框挂 select2 后仍是多选
 * - closeOnSelect: false：多选要能连续勾选
 * - dropdownParent: 最近的 dialog.popup，避免下拉被弹窗裁切
 *
 * @returns {number} 本次新挂载的数量
 */
function attachExtrasSelect2() {
    if (!ENABLE_ON_TOUCH || isTouchDevice()) {
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
        console.log(`[OpenAI Model Search] PC 已给 ${attached} 个辅助 Lorebook 下拉挂上 select2（保持多选）`);
    }

    return attached;
}

// ==========================================================================
// 三、移动端：自定义弹窗选择器
// ==========================================================================

/**
 * 当前选中项展示文本。
 * @param {JQuery<HTMLSelectElement>} $select
 * @param {{multiple: boolean}} config
 * @returns {string}
 */
function triggerLabel($select, config) {
    const el = $select.get(0);

    if (!el) {
        return '';
    }

    const selected = Array.from(el.selectedOptions).filter((o) => o.value !== '');

    if (selected.length === 0) {
        return config.multiple ? EXTRAS_PLACEHOLDER : '';
    }

    if (config.multiple) {
        return selected.map((o) => o.textContent.trim()).join('、');
    }

    return selected[0].textContent.trim();
}

/**
 * 渲染弹窗列表。
 *
 * @param {JQuery<HTMLSelectElement>} $select
 * @param {JQuery} $list
 * @param {string} keyword
 * @param {{multiple: boolean}} config
 * @param {Set<string>} pending 多选时的暂存选中值
 */
function renderPickerList($select, $list, keyword, config, pending) {
    const el = $select.get(0);
    const kw = keyword.trim().toLowerCase();
    $list.empty();

    if (!el) {
        return;
    }

    let count = 0;

    /**
     * @param {HTMLOptionElement} opt
     */
    const appendItem = (opt) => {
        // 空 value 是占位项（例如「-- World Info not found --」），不参与选择
        if (!opt.value) {
            return;
        }

        const checked = config.multiple ? pending.has(opt.value) : opt.selected;
        const $item = $(`<div class="${ITEM_CLASS}" role="option"></div>`)
            .attr('data-value', opt.value)
            .attr('aria-selected', checked ? 'true' : 'false')
            .text(opt.textContent.trim());

        if (checked) {
            $item.addClass('is-selected');
        }

        $list.append($item);
        count++;
    };

    Array.from(el.children).forEach((node) => {
        if (node.tagName === 'OPTGROUP') {
            const opts = Array.from(node.querySelectorAll('option'))
                .filter((o) => !kw || o.textContent.toLowerCase().includes(kw));

            if (opts.length === 0) {
                return;
            }

            $list.append($(`<div class="${GROUP_CLASS}"></div>`).text(node.getAttribute('label') || ''));
            opts.forEach(appendItem);
        } else if (node.tagName === 'OPTION') {
            if (!kw || node.textContent.toLowerCase().includes(kw)) {
                appendItem(/** @type {HTMLOptionElement} */ (node));
            }
        }
    });

    if (count === 0) {
        $list.append($(`<div class="${EMPTY_CLASS}"></div>`).text(PICKER_EMPTY));
    }
}

/**
 * 打开选择弹窗。
 *
 * 用原生 <dialog> + 酒馆的 .popup 系列 class，外观与宿主弹窗一致，
 * 且不依赖任何未随源码分发的宿主模块（便于离线验证）。
 *
 * @param {JQuery<HTMLSelectElement>} $select
 * @param {{multiple: boolean, title: string, placeholder: string}} config
 * @param {JQuery} $trigger 触发按钮，提交后刷新其文本
 */
function openPicker($select, config, $trigger) {
    // 空 value 是占位项（例如「-- World Info not found --」），不参与选择。
    // 必须与 renderPickerList / triggerLabel 用同一套过滤，否则会出现
    // 「确定 (1) 但点进去什么都没勾、提交值里混进一个空串」。
    const current = new Set(
        Array.from($select.get(0).selectedOptions)
            .map((o) => o.value)
            .filter((v) => v !== ''),
    );
    const pending = new Set(current);

    const $dialog = $(`<dialog class="popup ${PICKER_CLASS}"></dialog>`);
    const $body = $('<div class="popup-body"></div>');
    const $content = $('<div class="popup-content"></div>');
    const $title = $('<h3 class="popup-header"></h3>').text(config.title);
    const $search = $(`<input type="text" class="${SEARCH_INPUT_CLASS} oms-picker-search" autocomplete="off">`)
        .attr('placeholder', config.placeholder);
    const $list = $(`<div class="${LIST_CLASS}"></div>`);
    const $footer = $('<div class="oms-picker-footer"></div>');
    const $cancel = $(`<div class="menu_button oms-picker-cancel"></div>`).text(PICKER_CANCEL);
    const $confirm = $(`<div class="menu_button oms-picker-confirm"></div>`).text(PICKER_CONFIRM);

    $footer.append($cancel);

    // 单选点一下即提交，不需要确认按钮
    if (config.multiple) {
        $footer.append($confirm);
    }

    $content.append($title, $search, $list, $footer);
    $body.append($content);
    $dialog.append($body);
    $(document.body).append($dialog);

    renderPickerList($select, $list, '', config, pending);

    const syncConfirm = () => {
        if (config.multiple) {
            $confirm.text(`${PICKER_CONFIRM} (${pending.size})`);
        }
    };

    syncConfirm();

    $search.on('input', () => renderPickerList($select, $list, String($search.val() || ''), config, pending));

    $list.on('click', `.${ITEM_CLASS}`, function () {
        const value = String($(this).data('value'));

        if (!config.multiple) {
            // 单选：立即提交
            $select.val(value).trigger('change');
            close();
            return;
        }

        if (pending.has(value)) {
            pending.delete(value);
        } else {
            pending.add(value);
        }

        renderPickerList($select, $list, String($search.val() || ''), config, pending);
        syncConfirm();
    });

    let closed = false;

    function close() {
        if (closed) {
            return;
        }

        closed = true;

        // 先关再移除，避免残留遮罩
        const dlg = /** @type {HTMLDialogElement} */ ($dialog.get(0));

        if (dlg && dlg.open) {
            dlg.close();
        }

        if ($select.data('omsPicker') === $dialog) {
            $select.removeData('omsPicker');
        }

        $dialog.remove();
    }

    // Esc / 程序化 close() 都会触发 dialog 的 close 事件。
    // 只把关闭绑在按钮上的话，按 Esc 关掉的弹窗会永远留在 DOM 里（节点 + 事件句柄
    // 随使用次数无限堆积），而且残留的那层还会成为「连开两次」的温床。
    $dialog.on('close', close);

    $cancel.on('click', close);

    $confirm.on('click', () => {
        // 多选：一次性提交，触发宿主 script.js:9576 的 change 处理
        $select.val(Array.from(pending)).trigger('change');
        close();
    });

    // 记在 select 上，供「已开着就不要再开一层」的防重入检查使用
    $select.data('omsPicker', $dialog);

    const dlg = /** @type {HTMLDialogElement} */ ($dialog.get(0));

    if (dlg && typeof dlg.showModal === 'function') {
        dlg.showModal();
    } else {
        // 极老浏览器兜底：直接显示
        $dialog.attr('open', 'open');
    }

    if ($search.get(0)) {
        $search.get(0).focus();
    }
}

/**
 * 用「触发按钮 + 弹窗」接管一个原生 select（移动端）。
 *
 * 原生 select 只是被隐藏（class 控制），**仍留在 DOM 里**，
 * 因此宿主 openai.js / script.js 的 `.val()` 读写与 change 监听全部照常工作。
 *
 * @param {JQuery<HTMLSelectElement>} $select
 * @param {{multiple: boolean, title: string, placeholder: string}} config
 * @returns {boolean} 是否本次接管
 */
function takeOverWithPicker($select, config) {
    if ($select.length === 0 || $select.data('omsPicked')) {
        return false;
    }

    // 兜底：若已被 select2 接管（宿主、别的扩展、或判定分歧时宿主先挂了），
    // 绝不再叠一层弹窗 UI——两套控件同时出现，用户会看到两个下拉。
    if ($select.hasClass(SELECT2_CLASS)) {
        return false;
    }

    $select.data('omsPicked', true);
    $select.addClass(NATIVE_HIDDEN_CLASS);

    const $trigger = $(`<div class="${TRIGGER_CLASS} ${SEARCH_INPUT_CLASS}" role="button" tabindex="0"></div>`);
    $select.after($trigger);

    const sync = () => {
        const label = triggerLabel($select, config);
        $trigger.text(label);

        if (!label) {
            $trigger.addClass('is-empty');
        } else {
            $trigger.removeClass('is-empty');
        }
    };

    const open = () => {
        // 防重入：若这个 select 的弹窗还开着，就不要再叠一层。
        // 多层全屏 dialog 叠起来时，点「取消」只关最上面那层，得按好几次才退得出去。
        const existing = $select.data('omsPicker');

        if (existing && existing.get(0) && existing.get(0).open) {
            return;
        }

        // 宿主（或其它脚本）可能没走 change 事件就改了值，打开前刷新一次显示，
        // 避免按钮上显示 A、实际生效的是 B
        sync();
        openPicker($select, config, $trigger);
    };

    $trigger.on('click', open);
    $trigger.on('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
        }
    });

    // 外部（宿主/其它脚本）改动了值时，触发按钮的文本要跟着变
    $select.on('change.oms', sync);
    sync();

    return true;
}

/**
 * 扫描并用弹窗接管移动端的两处下拉。
 * @returns {number} 本次新接管的个数
 */
function attachPickers() {
    if (!ENABLE_ON_TOUCH || !USE_PICKER_ON_TOUCH || !isTouchDevice()) {
        return 0;
    }

    let taken = 0;

    if (takeOverWithPicker($(SELECT_SELECTOR), {
        multiple: false,
        title: MODEL_PICKER_TITLE,
        placeholder: SEARCH_PLACEHOLDER,
    })) {
        taken++;
    }

    $(EXTRAS_SELECT_SELECTOR).each((i, el) => {
        const $select = $(el);

        // 同样要避开静态模板里那份（它会被 clone 进真实弹窗）
        if ($select.closest(`.${TEMPLATE_HOLDER_CLASS}`).length > 0) {
            return;
        }

        if (!$select.get(0) || !$select.get(0).isConnected) {
            return;
        }

        if (takeOverWithPicker($select, {
            multiple: true,
            title: LOREBOOK_PICKER_TITLE,
            placeholder: EXTRAS_SEARCH_PLACEHOLDER,
        })) {
            taken++;
        }
    });

    if (taken > 0) {
        console.log(`[OpenAI Model Search] 移动端已用弹窗选择器接管 ${taken} 个下拉`);
    }

    return taken;
}

// ==========================================================================
// 四、监听与入口
// ==========================================================================

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
            attachPickers();
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

    if (!select) {
        return;
    }

    // 移动端被弹窗接管后，不需要监听 option 重建（弹窗每次打开都现读 option）
    if (USE_PICKER_ON_TOUCH && isTouchDevice()) {
        return;
    }

    if (observer) {
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
 * 入口：移动端走弹窗、桌面端走 select2；元素未就绪则在 APP_READY 时重试。
 */
function init() {
    if (!ENABLE_ON_TOUCH && isTouchDevice()) {
        console.log('[OpenAI Model Search] 触摸设备，保持原生选择器');
        return;
    }

    // 辅助 Lorebook 是动态元素，与模型下拉是否就绪无关，独立启动监听
    watchExtrasSelect();

    // 移动端：用弹窗接管两处下拉，不挂 select2
    if (USE_PICKER_ON_TOUCH && isTouchDevice()) {
        if (attachPickers() > 0 || $(SELECT_SELECTOR).length > 0) {
            return;
        }
    } else if (attachSelect2()) {
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
