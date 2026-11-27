'use strict';

/**
 * WordBridge input / animation / viewport regression tests.
 *
 * Run with a local browser:
 *   CHROME_PATH=/usr/sbin/chromium node tests/ui/game-ui.test.js
 *
 * No npm install or network access is required. Screenshots are written to
 * screenshots/ui/ (already gitignored); override with UI_SCREENSHOT_DIR.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const {
  Browser,
  startStaticServer
} = require('../helpers/browser');

const ROOT = path.resolve(__dirname, '..', '..');
const SCREENSHOTS = process.env.UI_SCREENSHOT_DIR || path.join(ROOT, 'screenshots', 'ui');
const UI_MATCH_ID = 'ui-test-match-1';

function playingSnapshot({
  deadlineMs = 10000,
  round = 1,
  totalRounds = 10,
  playerNames = null,
  submittedOpponents = 0
} = {}) {
  const now = Date.now();
  const matchId = UI_MATCH_ID;
  const names = playerNames && playerNames.length ? playerNames : ['Tester'];
  return {
    code: 'UITEST',
    state: 'playing',
    hostId: 'p1',
    maxPlayers: 8,
    categories: { noun_adj_verb: true, countries: true, us_states: true, us_cities: true },
    players: names.map((name, index) => ({
      id: `p${index + 1}`,
      name,
      score: 0,
      ready: true,
      comfortMode: false,
      connected: true,
      submitted: index > 0 && index <= submittedOpponents
    })),
    matchId,
    roundStart: {
      round,
      totalRounds,
      startLetter: 'A',
      endLetter: 'T',
      timeLeft: 10,
      deadline: now + deadlineMs,
      matchId
    },
    ownSubmission: null,
    lastRoundEnd: null,
    gameEnd: null,
    pauseDeadline: null,
    playAgainVoterIds: [],
    serverNow: now
  };
}

async function firePlayingState(page, options = {}) {
  const snapshot = playingSnapshot(options);
  await page.evaluate(state => {
    window.__socket.fire('nameConfirmed', {
      playerId: 'p1',
      name: 'Tester',
      resumeToken: 'ui-test-resume-token',
      resumed: false
    });
    window.__socket.fire('roomStateRestored', state);
  }, snapshot);
}

const COMFORT_INIT = `(() => {
  try { localStorage.setItem('wb_comfort_mode', JSON.stringify({ enabled: true })); } catch (e) {}
})()`;

// The browser profile (and therefore localStorage) is shared by every page in
// this suite. Clear the persisted comfort preference unless a test asks for
// it, otherwise later viewport/contrast tests silently run in Comfort Mode.
const NO_COMFORT_INIT = `(() => {
  try { localStorage.removeItem('wb_comfort_mode'); } catch (e) {}
})()`;

const VIEWPORTS = [
  { name: 'phone-320x568', width: 320, height: 568 },
  { name: 'phone-360x640', width: 360, height: 640 },
  { name: 'phone-390x844', width: 390, height: 844 },
  { name: 'landscape-568x320', width: 568, height: 320 },
  { name: 'landscape-667x375', width: 667, height: 375 },
  { name: 'landscape-844x390', width: 844, height: 390 },
  { name: 'narrow-280x653', width: 280, height: 653 },
  { name: 'short-320x480', width: 320, height: 480 }
];

async function openGame(browser, origin, options = {}) {
  const {
    width = 390,
    height = 844,
    deadlineMs = 10000,
    comfort = false,
    safeArea = null,
    reduceMotion = false,
    contrast = false,
    waitMs = 1000,
    playerNames = null,
    submittedOpponents = 0
  } = options;

  const mediaFeatures = [];
  if (reduceMotion) mediaFeatures.push({ name: 'prefers-reduced-motion', value: 'reduce' });
  if (contrast) mediaFeatures.push({ name: 'prefers-contrast', value: 'more' });
  const media = mediaFeatures.length ? { features: mediaFeatures } : null;
  const initScripts = [comfort ? COMFORT_INIT : NO_COMFORT_INIT];

  const page = await browser.newPage({
    width,
    height,
    origin,
    safeArea,
    media,
    initScripts
  });

  await page.goto(origin + '/');
  await page.waitForFunction(() => window.__socket && document.getElementById('wordDisplay'));
  // The client checks the dictionary before allowing a valid submission.
  await page.waitForFunction(() => {
    try {
      return typeof wordLookupClient !== 'undefined' &&
        Object.keys(wordLookupClient).length > 0 &&
        typeof wordCategoriesClient !== 'undefined' &&
        Object.keys(wordCategoriesClient).length > 0;
    } catch {
      return false;
    }
  }, [], 8000);

  await firePlayingState(page, { deadlineMs, playerNames, submittedOpponents });

  await page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'gameScreen');
  await page.waitForTimeout(waitMs);
  return page;
}

async function resetRound(page, deadlineMs = 10000) {
  await page.evaluate((deadline) => {
    window.__socket.fire('roundStart', {
      round: 2,
      totalRounds: 10,
      startLetter: 'A',
      endLetter: 'T',
      deadline: Date.now() + deadline,
      timeLeft: 10,
      matchId: 'ui-test-match-1'
    });
  }, deadlineMs);
  await page.waitForTimeout(700);
}

async function addSubmissionChips(page, count = 8) {
  await page.evaluate((n) => {
    const container = document.getElementById('submissionsStatus');
    const names = ['Blake', 'Casey', 'Dana', 'Eli', 'Frank', 'Gale', 'Hana', 'Ira'];
    for (let i = 0; i < n; i += 1) {
      const chip = document.createElement('div');
      chip.className = 'submission-item';
      chip.dataset.pid = `test-${i}`;
      chip.textContent = names[i % names.length];
      container.appendChild(chip);
    }
  }, count);
  await page.waitForTimeout(700);
}

function wordValue(page) {
  return page.evaluate(() => document.getElementById('wordDisplayValue').textContent.trim());
}

function feedback(page) {
  return page.evaluate(() => document.getElementById('wordFeedback').textContent.trim());
}

function emitted(page) {
  return page.evaluate(() => window.__socketEmits);
}

async function controlGeometry(page) {
  return page.evaluate(() => {
    const rect = element => {
      const r = element.getBoundingClientRect();
      return {
        top: +r.top.toFixed(1),
        right: +r.right.toFixed(1),
        bottom: +r.bottom.toFixed(1),
        left: +r.left.toFixed(1),
        width: +r.width.toFixed(1),
        height: +r.height.toFixed(1)
      };
    };
    const nameOf = element => element.id || element.dataset.key || element.getAttribute('aria-label') || element.textContent.trim();
    const visible = element => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
    };

    const game = document.getElementById('gameScreen');
    const gameRect = game.getBoundingClientRect();
    const gameStyle = getComputedStyle(game);
    const contentBox = {
      top: gameRect.top + parseFloat(gameStyle.paddingTop),
      right: gameRect.right - parseFloat(gameStyle.paddingRight),
      bottom: gameRect.bottom - parseFloat(gameStyle.paddingBottom),
      left: gameRect.left + parseFloat(gameStyle.paddingLeft)
    };

    const interactive = [
      ...document.querySelectorAll('#gameKeyboard .word-key'),
      document.getElementById('submitWordBtn'),
      ...document.querySelectorAll('#gameReactions .reaction-btn'),
      document.getElementById('wordDisplay')
    ];
    const layoutControls = [
      ...interactive,
      document.querySelector('#gameScreen .game-header'),
      document.querySelector('#gameScreen .round-info'),
      document.querySelector('#gameScreen .room-code-chip'),
      document.getElementById('scoreHint'),
      document.getElementById('timer'),
      document.getElementById('wordFeedback'),
      document.getElementById('tile1'),
      document.getElementById('tile2')
    ].filter(Boolean);

    const clipped = layoutControls
      .filter(element => {
        const r = element.getBoundingClientRect();
        return r.width < 1 || r.height < 1 || !visible(element) ||
          r.top < -0.5 || r.left < -0.5 ||
          r.bottom > innerHeight + 0.5 || r.right > innerWidth + 0.5;
      })
      .map(nameOf);
    const outsideSafeArea = layoutControls
      .filter(element => {
        const r = element.getBoundingClientRect();
        return r.top < contentBox.top - 0.75 ||
          r.left < contentBox.left - 0.75 ||
          r.bottom > contentBox.bottom + 0.75 ||
          r.right > contentBox.right + 0.75;
      })
      .map(nameOf);
    const covered = interactive
      .filter(element => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !hit || !(element === hit || element.contains(hit));
      })
      .map(nameOf);

    const keyboard = document.querySelector('.game-keyboard');
    const feedbackEl = document.getElementById('wordFeedback');
    const status = document.getElementById('submissionsStatus');

    return {
      innerWidth,
      innerHeight,
      docScrollHeight: document.documentElement.scrollHeight,
      docScrollWidth: document.documentElement.scrollWidth,
      scrollY,
      scrollX,
      htmlOverflow: getComputedStyle(document.documentElement).overflowY,
      bodyOverflow: getComputedStyle(document.body).overflowY,
      gamePosition: getComputedStyle(game).position,
      keyboard: rect(keyboard),
      keyboardTop: +keyboard.getBoundingClientRect().top.toFixed(1),
      feedbackRect: rect(feedbackEl),
      feedbackText: feedbackEl.textContent,
      statusScrollWidth: status.scrollWidth,
      statusClientWidth: status.clientWidth,
      statusScrollLeft: status.scrollLeft,
      clipped,
      outsideSafeArea,
      covered
    };
  });
}

async function testCriticalTiles(page, { expectShake = true } = {}) {
  await page.waitForFunction(() => document.getElementById('gameScreen').classList.contains('screen-critical'));

  const state = await page.evaluate(async () => {
    const tiles = document.querySelector('.tiles');
    const sample = () => {      const tile1 = document.getElementById('tile1');
      const tile2 = document.getElementById('tile2');
      const style1 = getComputedStyle(tile1);
      const style2 = getComputedStyle(tile2);
      const tilesStyle = getComputedStyle(tiles);
      const rect2 = tile2.getBoundingClientRect();
      return {
        opacity1: style1.opacity,
        opacity2: style2.opacity,
        visibility1: style1.visibility,
        visibility2: style2.visibility,
        width2: rect2.width,
        height2: rect2.height,
        transform: tilesStyle.transform,
        animationName: tilesStyle.animationName,
        animationPlayState: tilesStyle.animationPlayState
      };
    };

    // Let the style/animation frame settle before sampling steady-state
    // visibility; the onset-during-entrance test above deliberately samples
    // the very first frame instead.
    await new Promise(resolve => requestAnimationFrame(resolve));
    const samples = [sample()];
    for (let i = 0; i < 12; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
      samples.push(sample());
    }
    return {
      samples,
      tile1: document.getElementById('tile1').textContent,
      tile2: document.getElementById('tile2').textContent,
      critical: document.getElementById('gameScreen').classList.contains('screen-critical')
    };
  });

  assert.equal(state.critical, true, 'critical shake state should be active');
  assert.equal(state.tile1, 'A');
  assert.equal(state.tile2, 'T');
  const bad = state.samples.filter(sample =>
    sample.opacity1 !== '1' ||
    sample.opacity2 !== '1' ||
    sample.visibility1 !== 'visible' ||
    sample.visibility2 !== 'visible' ||
    sample.width2 < 1 ||
    sample.height2 < 1
  );
  assert.deepEqual(
    bad,
    [],
    `both letter tiles must stay visible through every sampled shake frame: ${JSON.stringify(bad)}`
  );

  const first = state.samples[0];
  if (expectShake) {
    assert.match(first.animationName, /tileShake/,
      `the critical shake must animate the tiles container (got ${first.animationName})`);
    assert.equal(first.animationPlayState, 'running',
      `the critical shake must actually be running (got ${first.animationPlayState})`);
    assert.ok(
      state.samples.some(sample => sample.transform !== first.transform),
      `the critical shake must move the tiles over time: ${JSON.stringify(state.samples.map(s => s.transform))}`
    );
  } else {
    assert.equal(first.animationName, 'none', 'this mode must suppress the critical shake');
  }
  return state;
}

function assertSameKeyboardRect(before, after, label) {
  for (const key of ['top', 'left', 'width', 'height']) {
    assert.ok(
      Math.abs(after.keyboard[key] - before.keyboard[key]) <= 0.75,
      `${label}: keyboard ${key} moved ${before.keyboard[key]} -> ${after.keyboard[key]}`
    );
  }
}

async function testCriticalOnsetDuringEntrance(page) {
  await page.waitForFunction(() => document.getElementById('gameScreen').classList.contains('screen-critical'));

  const state = await page.evaluate(async () => {
    const sample = () => {
      const tile2 = document.getElementById('tile2');
      const style1 = getComputedStyle(document.getElementById('tile1'));
      const style2 = getComputedStyle(tile2);
      const rect2 = tile2.getBoundingClientRect();
      return {
        opacity1: style1.opacity,
        opacity2: style2.opacity,
        visibility2: style2.visibility,
        width2: rect2.width,
        height2: rect2.height
      };
    };
    const samples = [sample()];
    await new Promise(resolve => requestAnimationFrame(resolve));
    samples.push(sample());
    for (let i = 0; i < 6; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
      samples.push(sample());
    }
    return { samples };
  });

  const bad = state.samples.filter(sample =>
    sample.opacity1 !== '1' ||
    sample.opacity2 !== '1' ||
    sample.visibility2 !== 'visible' ||
    sample.width2 < 1 ||
    sample.height2 < 1
  );
  assert.deepEqual(
    bad,
    [],
    `the second tile must not flash dark when critical starts during its entrance: ${JSON.stringify(bad)}`
  );
  return state;
}

async function run() {
  const server = await startStaticServer(ROOT);
  const browser = await Browser.launch();
  const results = [];

  async function test(name, fn) {
    try {
      await fn();
      results.push({ ok: true, name });
      console.log(`PASS  ${name}`);
    } catch (error) {
      results.push({ ok: false, name, error });
      console.log(`FAIL  ${name}\n      ${error.message}`);
    }
  }

  try {
    await test('game screen has no native text entry and exposes accessible keyboard controls', async () => {
      const page = await openGame(browser, server.origin);
      try {
        const info = await page.evaluate(() => {
          const word = document.getElementById('wordDisplay');
          const keys = [...document.querySelectorAll('#gameKeyboard .word-key')];
          return {
            editableCount: document.querySelectorAll('#gameScreen input, #gameScreen textarea, #gameScreen [contenteditable="true"]').length,
            oldInput: !!document.getElementById('wordInput'),
            letterKeys: document.querySelectorAll('#gameKeyboard .word-key[data-key]').length,
            backspaceKeys: document.querySelectorAll('#gameKeyboard .word-key[data-action="backspace"]').length,
            totalKeys: keys.length,
            unlabeledKeys: keys.filter(key => !key.getAttribute('aria-label')).length,
            submitLabel: document.getElementById('submitWordBtn').getAttribute('aria-label'),
            wordRole: word.getAttribute('role'),
            wordTabIndex: word.getAttribute('tabindex'),
            wordDescribedBy: word.getAttribute('aria-describedby'),
            liveRegion: document.getElementById('wordDisplayAnnounce').getAttribute('aria-live'),
            activeId: document.activeElement.id
          };
        });

        assert.equal(info.editableCount, 0, 'game screen must contain no editable field');
        assert.equal(info.oldInput, false, 'old textbox #wordInput must be gone');
        assert.equal(info.letterKeys, 27, 'expected 26 letters plus hyphen');
        assert.equal(info.backspaceKeys, 1);
        assert.equal(info.totalKeys, 28);
        assert.equal(info.unlabeledKeys, 0, 'every key needs an aria-label');
        assert.equal(info.submitLabel, 'Submit word');
        assert.equal(info.wordRole, 'group');
        assert.equal(info.wordTabIndex, '0');
        assert.equal(info.wordDescribedBy, 'wordInputHelp');
        assert.equal(info.liveRegion, 'polite');
        assert.equal(info.activeId, 'wordDisplay', 'round start should focus the non-editable display');
        assert.deepEqual(page.pageErrors, []);

        await page.screenshot(path.join(SCREENSHOTS, 'game-phone-390x844.png'));
      } finally {
        await page.close();
      }
    });

    await test('on-screen keyboard types, deletes, supports hyphen, and submits', async () => {
      const page = await openGame(browser, server.origin);
      try {
        // Real hit-testable pointer clicks for letters, delete and submit.
        await page.pointerClick('[aria-label="Letter A"]');
        await page.pointerClick('[aria-label="Letter R"]');
        await page.pointerClick('[aria-label="Letter T"]');
        assert.equal(await wordValue(page), 'ART');

        await page.pointerClick('[aria-label="Delete last letter"]');
        assert.equal(await wordValue(page), 'AR');
        assert.equal(
          await page.evaluate(() => document.activeElement.id),
          'wordDisplay',
          'real pointer delete must also return focus to the answer display'
        );
        await page.pointerClick('[aria-label="Letter T"]');
        assert.equal(await wordValue(page), 'ART');

        await page.pointerClick('[aria-label="Hyphen"]');
        assert.equal(await wordValue(page), 'ART-');
        await page.pointerClick('[aria-label="Delete last letter"]');
        assert.equal(await wordValue(page), 'ART');

        await page.pointerClick('#submitWordBtn');
        const emits = await emitted(page);
        assert.equal(emits.filter(item => item.event === 'submitWord').length, 1);
        assert.deepEqual(
          emits.find(item => item.event === 'submitWord').data,
          { word: 'art', matchId: UI_MATCH_ID, round: 1 }
        );

        const after = await page.evaluate(() => ({
          disabledKeys: [...document.querySelectorAll('#gameKeyboard .word-key')].every(key => key.disabled),
          disabledSubmit: document.getElementById('submitWordBtn').disabled,
          activeId: document.activeElement.id,
          feedback: document.getElementById('wordFeedback').textContent
        }));
        assert.equal(after.disabledKeys, true);
        assert.equal(after.disabledSubmit, true);
        assert.equal(after.activeId, 'wordDisplay');
        assert.match(after.feedback, /Word sent/);
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    for (const pointerMethod of ['pointerClick', 'tap']) {
      await test(`mixed ${pointerMethod} key + hardware typing submits once without spurious letters`, async () => {
        const page = await openGame(browser, server.origin);
        try {
          // Real CDP mouse/touch click, not element.click(): this must focus
          // the letter button first, then our app should hand focus back.
          await page[pointerMethod]('[aria-label="Letter A"]');

          const afterClick = await page.evaluate(() => ({
            word: document.getElementById('wordDisplayValue').textContent.trim(),
            activeId: document.activeElement.id,
            activeLabel: document.activeElement.getAttribute && document.activeElement.getAttribute('aria-label')
          }));
          assert.equal(afterClick.word, 'A');
          assert.equal(
            afterClick.activeId,
            'wordDisplay',
            `${pointerMethod} should return focus to the non-editable answer display (active: ${afterClick.activeId || afterClick.activeLabel})`
          );

          await page.press('r');
          await page.press('t');
          assert.equal(await wordValue(page), 'ART');
          assert.equal(
            await page.evaluate(() => document.activeElement.id),
            'wordDisplay',
            'hardware letters should continue while the answer display keeps focus'
          );

          await page.press('Enter');
          const submits = (await emitted(page)).filter(item => item.event === 'submitWord');
          assert.equal(submits.length, 1, 'hardware Enter must submit, not re-activate the letter key');
          assert.deepEqual(submits[0].data, { word: 'art', matchId: UI_MATCH_ID, round: 1 });
          assert.equal(await wordValue(page), 'ART', 'Enter must not append the pointer-clicked letter again');
          assert.deepEqual(page.pageErrors, []);
        } finally {
          await page.close();
        }
      });
    }

    await test('native keyboard Tab/Space/Enter on a letter button keeps button focus and activates it once', async () => {
      const page = await openGame(browser, server.origin);
      try {
        await page.press('Tab');
        const firstFocus = await page.evaluate(() => ({
          id: document.activeElement.id,
          label: document.activeElement.getAttribute && document.activeElement.getAttribute('aria-label')
        }));
        assert.equal(firstFocus.id, '', 'focus should leave the answer display');
        assert.equal(firstFocus.label, 'Letter Q', 'Tab should reach the first on-screen letter');

        await page.press(' ');
        assert.equal(await wordValue(page), 'Q');
        assert.equal(
          await page.evaluate(() => document.activeElement.getAttribute && document.activeElement.getAttribute('aria-label')),
          'Letter Q',
          'Space activation must keep focus on the letter button'
        );

        await page.press('Enter');
        assert.equal(await wordValue(page), 'QQ', 'Enter activation must add exactly one letter');
        assert.equal(
          await page.evaluate(() => document.activeElement.getAttribute && document.activeElement.getAttribute('aria-label')),
          'Letter Q',
          'Enter activation must keep focus on the letter button for accessible semantics'
        );

        // Programmatic/AT-style activation (detail 0, no pointer origin) must
        // also keep focus on the activated button.
        await page.evaluate(() => document.querySelector('[aria-label="Letter Q"]').click());
        assert.equal(await wordValue(page), 'QQQ');
        assert.equal(
          await page.evaluate(() => document.activeElement.getAttribute && document.activeElement.getAttribute('aria-label')),
          'Letter Q',
          'AT-style activation must keep focus on the letter button'
        );
        assert.equal((await emitted(page)).filter(item => item.event === 'submitWord').length, 0);
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('modifiers, IME composition and editable fields do not type into the answer', async () => {
      const page = await openGame(browser, server.origin);
      try {
        for (const modifiers of [1, 2, 4]) {
          await page.press('a', { modifiers });
        }
        assert.equal(
          await page.evaluate(() => document.getElementById('wordDisplay').classList.contains('empty')),
          true,
          'Alt/Ctrl/Meta shortcuts must not append letters'
        );

        const ime = await page.evaluate(() => {
          const target = document.activeElement;
          const event = new KeyboardEvent('keydown', {
            key: 'z',
            bubbles: true,
            cancelable: true,
            isComposing: true
          });
          if (!event.isComposing) {
            Object.defineProperty(event, 'isComposing', { value: true });
          }
          target.dispatchEvent(event);
          return {
            composing: event.isComposing,
            empty: document.getElementById('wordDisplay').classList.contains('empty')
          };
        });
        assert.equal(ime.composing, true);
        assert.equal(ime.empty, true, 'IME composition must not append text');

        await page.evaluate(() => {
          const input = document.createElement('input');
          input.id = '__editableProbe';
          input.style.cssText = 'position:fixed;left:0;top:0;width:12px;opacity:0;';
          document.getElementById('gameScreen').appendChild(input);
          input.focus();
        });
        await page.press('x');
        const editable = await page.evaluate(() => ({
          empty: document.getElementById('wordDisplay').classList.contains('empty'),
          inputValue: document.getElementById('__editableProbe').value,
          activeId: document.activeElement.id
        }));
        assert.equal(editable.empty, true, 'editable targets must not fall through into the game answer');
        assert.equal(editable.inputValue, 'x');
        assert.equal(editable.activeId, '__editableProbe');
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('hardware typing, Delete/Backspace, and Enter work', async () => {
      const page = await openGame(browser, server.origin);
      try {
        await page.press('a');
        await page.press('r');
        await page.press('t');
        assert.equal(await wordValue(page), 'ART');

        await page.press('Backspace');
        assert.equal(await wordValue(page), 'AR');
        await page.press('t');
        assert.equal(await wordValue(page), 'ART');

        await page.press('Delete');
        assert.equal(await wordValue(page), 'AR');
        await page.press('t');
        assert.equal(await wordValue(page), 'ART');

        // Non-dictionary characters must not corrupt the word.
        await page.press('1');
        await page.press('!');
        assert.equal(await wordValue(page), 'ART');

        await page.press('Enter');
        const submits = (await emitted(page)).filter(item => item.event === 'submitWord');
        assert.equal(submits.length, 1);
        assert.deepEqual(
          submits[0].data,
          { word: 'art', matchId: UI_MATCH_ID, round: 1 }
        );
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('validation keeps existing min-length/dictionary rules and preserves entry', async () => {
      const page = await openGame(browser, server.origin);
      try {
        const keyboardTopBefore = await page.evaluate(() => document.querySelector('.game-keyboard').getBoundingClientRect().top);

        await page.click('#submitWordBtn');
        assert.match(await feedback(page), /Type a word first/);
        assert.equal((await emitted(page)).filter(item => item.event === 'submitWord').length, 0);

        await page.click('[aria-label="Letter A"]');
        await page.click('[aria-label="Letter T"]');
        await page.click('#submitWordBtn');
        assert.match(await feedback(page), /at least 3 letters/);
        assert.equal(await wordValue(page), 'AT');
        assert.equal((await emitted(page)).filter(item => item.event === 'submitWord').length, 0);

        const keyboardTopAfter = await page.evaluate(() => document.querySelector('.game-keyboard').getBoundingClientRect().top);
        assert.ok(Math.abs(keyboardTopAfter - keyboardTopBefore) <= 0.75,
          `keyboard moved when validation feedback appeared: ${keyboardTopBefore} -> ${keyboardTopAfter}`);
        const feedbackVisibility = await page.evaluate(() => {
          const el = document.getElementById('wordFeedback');
          const style = getComputedStyle(el);
          return {
            display: style.display,
            height: el.getBoundingClientRect().height,
            color: style.color
          };
        });
        assert.notEqual(feedbackVisibility.display, 'none', 'validation feedback must be visible');
        assert.ok(feedbackVisibility.height > 0, 'validation feedback must occupy its fixed line');
        assert.equal(feedbackVisibility.color, 'rgb(255, 90, 90)', 'error feedback must use the error color');

        await resetRound(page);
        await page.click('[aria-label="Letter A"]');
        await page.click('[aria-label="Letter B"]');
        await page.click('[aria-label="Letter T"]');
        await page.click('#submitWordBtn');
        assert.match(await feedback(page), /not in dictionary/);
        assert.equal(await wordValue(page), 'ABT');

        await resetRound(page);
        await page.click('[aria-label="Letter B"]');
        await page.click('[aria-label="Letter A"]');
        await page.click('[aria-label="Letter T"]');
        await page.click('#submitWordBtn');
        assert.match(await feedback(page), /start with A/i);
        assert.equal(await wordValue(page), 'BAT');

        await page.click('[aria-label="Delete last letter"]');
        await page.click('[aria-label="Delete last letter"]');
        await page.click('[aria-label="Delete last letter"]');
        await page.click('[aria-label="Letter A"]');
        await page.click('[aria-label="Letter R"]');
        await page.click('[aria-label="Letter C"]');
        await page.click('#submitWordBtn');
        assert.match(await feedback(page), /end with T/i);
        assert.equal(await wordValue(page), 'ARC');
        assert.equal((await emitted(page)).filter(item => item.event === 'submitWord').length, 0);

        await resetRound(page);
        await page.click('[aria-label="Letter A"]');
        await page.click('[aria-label="Letter R"]');
        await page.click('[aria-label="Letter T"]');
        await page.click('#submitWordBtn');
        const submits = (await emitted(page)).filter(item => item.event === 'submitWord');
        assert.equal(submits.length, 1);
        assert.deepEqual(
          submits[0].data,
          { word: 'art', matchId: UI_MATCH_ID, round: 2 }
        );
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('20-character cap still applies without submitting malformed input', async () => {
      const page = await openGame(browser, server.origin);
      try {
        for (let i = 0; i < 21; i += 1) await page.press('a');
        assert.equal((await wordValue(page)).length, 20);
        assert.match(await feedback(page), /Maximum 20 characters/);
        assert.equal((await emitted(page)).filter(item => item.event === 'submitWord').length, 0);
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('client-side category filter rejects before sending and allows retry', async () => {
      const page = await openGame(browser, server.origin);
      try {
        await page.evaluate(() => {
          window.__socket.fire('categoriesUpdated', {
            categories: {
              noun_adj_verb: false,
              countries: false,
              us_states: false,
              us_cities: false
            }
          });
        });
        for (const letter of ['A', 'R', 'T']) {
          await page.click(`[aria-label="Letter ${letter}"]`);
        }
        await page.click('#submitWordBtn');
        assert.match(await feedback(page), /selected categories/i);
        assert.equal(await wordValue(page), 'ART', 'rejected category word must stay editable');
        assert.equal((await emitted(page)).filter(item => item.event === 'submitWord').length, 0);
        assert.equal(
          await page.evaluate(() => [...document.querySelectorAll('#gameKeyboard .word-key')].every(key => !key.disabled)),
          true,
          'category rejection must re-enable the keyboard'
        );

        await page.evaluate(() => {
          window.__socket.fire('categoriesUpdated', {
            categories: {
              noun_adj_verb: true,
              countries: true,
              us_states: true,
              us_cities: true
            }
          });
        });
        await page.click('#submitWordBtn');
        const submits = (await emitted(page)).filter(item => item.event === 'submitWord');
        assert.equal(submits.length, 1);
        assert.deepEqual(submits[0].data, { word: 'art', matchId: UI_MATCH_ID, round: 1 });
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('category rejection re-enables input and preserves the typed word', async () => {
      const page = await openGame(browser, server.origin);
      try {
        await page.click('[aria-label="Letter A"]');
        await page.click('[aria-label="Letter R"]');
        await page.click('[aria-label="Letter T"]');
        await page.click('#submitWordBtn');
        assert.equal((await emitted(page)).filter(item => item.event === 'submitWord').length, 1);

        await page.evaluate(() => {
          window.__socket.fire('error', {
            code: 'category_mismatch',
            message: 'Word does not match the selected categories'
          });
        });
        await page.waitForTimeout(100);

        const recovered = await page.evaluate(() => ({
          word: document.getElementById('wordDisplayValue').textContent.trim(),
          keysEnabled: [...document.querySelectorAll('#gameKeyboard .word-key')].every(key => !key.disabled),
          submitEnabled: !document.getElementById('submitWordBtn').disabled,
          activeId: document.activeElement.id,
          feedback: document.getElementById('wordFeedback').textContent
        }));
        assert.equal(recovered.word, 'ART');
        assert.equal(recovered.keysEnabled, true);
        assert.equal(recovered.submitEnabled, true);
        assert.equal(recovered.activeId, 'wordDisplay');
        assert.match(recovered.feedback, /selected categories/);
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('timer expiry disables input without changing scoring', async () => {
      const page = await openGame(browser, server.origin, { deadlineMs: 1100, waitMs: 1500 });
      try {
        const state = await page.evaluate(() => ({
          keysDisabled: [...document.querySelectorAll('#gameKeyboard .word-key')].every(key => key.disabled),
          submitDisabled: document.getElementById('submitWordBtn').disabled,
          feedback: document.getElementById('wordFeedback').textContent,
          emits: window.__socketEmits
        }));
        assert.equal(state.keysDisabled, true);
        assert.equal(state.submitDisabled, true);
        assert.match(state.feedback, /Time's up/);
        assert.equal(state.emits.filter(item => item.event === 'submitWord').length, 0);
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('both pair letters stay visible through the low-timer shake', async () => {
      const page = await openGame(browser, server.origin, { deadlineMs: 5000 });
      try {
        const state = await testCriticalTiles(page);
        assert.match(state.samples[0].animationName, /tileShake/);
        await page.screenshot(path.join(SCREENSHOTS, 'critical-shake-390x844.png'));
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('both pair letters are visible the instant critical starts during the tile entrance', async () => {
      // 4.15s leaves the critical threshold only ~150ms after the round starts,
      // while the delayed second-tile entrance is still at its 0% frame.
      const page = await openGame(browser, server.origin, { deadlineMs: 4150, waitMs: 0 });
      try {
        await testCriticalOnsetDuringEntrance(page);
        await page.screenshot(path.join(SCREENSHOTS, 'critical-onset-during-entrance-390x844.png'));
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('both pair letters are visible when a round starts already in the critical window', async () => {
      const page = await openGame(browser, server.origin, { deadlineMs: 3000, waitMs: 300 });
      try {
        await page.waitForFunction(() => document.getElementById('gameScreen').classList.contains('screen-critical'));
        const state = await page.evaluate(() => ({
          tile1: document.getElementById('tile1').textContent,
          tile2: document.getElementById('tile2').textContent,
          opacity1: getComputedStyle(document.getElementById('tile1')).opacity,
          opacity2: getComputedStyle(document.getElementById('tile2')).opacity,
          width2: document.getElementById('tile2').getBoundingClientRect().width
        }));
        assert.equal(state.tile1, 'A');
        assert.equal(state.tile2, 'T');
        assert.equal(state.opacity1, '1');
        assert.equal(state.opacity2, '1', 'second tile must not enter dark in an already-critical round');
        assert.ok(state.width2 > 0);
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('both pair letters stay visible in Comfort Mode during the shake', async () => {
      const page = await openGame(browser, server.origin, {
        width: 320,
        height: 568,
        deadlineMs: 5000,
        comfort: true
      });
      try {
        assert.equal(await page.evaluate(() => document.body.classList.contains('comfort-mode')), true);
        await testCriticalTiles(page, { expectShake: false });
        const beforeChips = await controlGeometry(page);
        await addSubmissionChips(page, 8);
        const geometry = await controlGeometry(page);
        assert.deepEqual(geometry.clipped, [], `clipped controls: ${JSON.stringify(geometry.clipped)}`);
        assert.ok(geometry.feedbackRect.height > 0, 'feedback line must remain visible in Comfort Mode');
        assert.ok(Math.abs(geometry.keyboardTop - beforeChips.keyboardTop) <= 0.75,
          `Comfort Mode keyboard moved when submissions arrived: ${beforeChips.keyboardTop} -> ${geometry.keyboardTop}`);
        await page.screenshot(path.join(SCREENSHOTS, 'critical-shake-comfort-320x568.png'));
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('both pair letters stay visible with reduced motion', async () => {
      const page = await openGame(browser, server.origin, {
        deadlineMs: 5000,
        reduceMotion: true
      });
      try {
        await testCriticalTiles(page, { expectShake: false });
        await page.screenshot(path.join(SCREENSHOTS, 'critical-shake-reduced-motion-390x844.png'));
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('high-contrast mode keeps the keyboard controls and critical tiles legible', async () => {
      const page = await openGame(browser, server.origin, {
        width: 320,
        height: 568,
        deadlineMs: 5000,
        contrast: true
      });
      try {
        const contrastState = await page.evaluate(() => {
          const display = getComputedStyle(document.getElementById('wordDisplay'));
          const key = getComputedStyle(document.querySelector('.word-key'));
          return {
            displayBorder: display.borderTopColor,
            keyBorder: key.borderTopColor,
            keyBackground: key.backgroundColor
          };
        });
        assert.equal(contrastState.displayBorder, 'rgb(255, 255, 255)');
        assert.equal(contrastState.keyBorder, 'rgb(255, 255, 255)');
        assert.equal(contrastState.keyBackground, 'rgb(0, 0, 0)');
        await testCriticalTiles(page);
        const geometry = await controlGeometry(page);
        assert.deepEqual(geometry.clipped, [], `high-contrast controls clipped: ${JSON.stringify(geometry.clipped)}`);
        assert.deepEqual(geometry.covered, [], `high-contrast controls covered: ${JSON.stringify(geometry.covered)}`);
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('a same-round reconnect preserves a partially typed answer', async () => {
      const page = await openGame(browser, server.origin);
      try {
        await page.press('a');
        await page.press('r');
        assert.equal(await wordValue(page), 'AR');

        await page.evaluate(state => {
          window.__socket.fire('nameConfirmed', {
            playerId: 'p1',
            name: 'Tester',
            resumeToken: 'ui-test-resume-token',
            resumed: true
          });
          window.__socket.fire('roomStateRestored', state);
        }, playingSnapshot({ deadlineMs: 10000 }));
        await page.waitForTimeout(120);
        assert.equal(await wordValue(page), 'AR', 'same round/match restore must keep the typed answer');
        assert.equal(await page.evaluate(() => isWordInputOpen()), true);

        await page.evaluate(state => {
          window.__socket.fire('roomStateRestored', state);
        }, playingSnapshot({ deadlineMs: 10000, round: 2 }));
        await page.waitForTimeout(120);
        assert.equal(await page.evaluate(() => currentWord), '', 'a different round must start with an empty answer');
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('a successful transport connect clears a stale browserOffline flag', async () => {
      const page = await openGame(browser, server.origin);
      try {
        await page.evaluate(() => {
          browserOffline = true;
          window.__socket.connected = false;
          window.__socket.connect();
        });
        assert.equal(await page.evaluate(() => browserOffline), false,
          'a live handshake proves connectivity even without an online event');
        await page.evaluate(state => {
          window.__socket.fire('roomStateRestored', state);
        }, playingSnapshot({ deadlineMs: 10000 }));
        await page.waitForTimeout(120);
        assert.equal(await page.evaluate(() => isWordInputOpen()), true,
          'input must reopen after the reconnect snapshot');
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('server-initiated disconnect retries; client-initiated disconnect does not', async () => {
      const page = await openGame(browser, server.origin);
      try {
        await page.evaluate(() => {
          window.__socketConnectCalls = 0;
          window.__socket.connected = false;
          window.__socket.fire('disconnect', 'io client disconnect');
        });
        await page.waitForTimeout(600);
        assert.equal(await page.evaluate(() => window.__socketConnectCalls), 0,
          'a client-initiated disconnect must not auto-retry');

        await page.evaluate(() => {
          window.__socketConnectCalls = 0;
          window.__socket.connected = false;
          window.__socket.fire('disconnect', 'io server disconnect');
        });
        await page.waitForTimeout(600);
        assert.ok(await page.evaluate(() => window.__socketConnectCalls) >= 1,
          'a server-rejected resume claim must retry the same token');
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('exhausted duplicate-tab retries offer an explicit new-player path', async () => {
      const page = await openGame(browser, server.origin);
      try {
        await page.evaluate(() => {
          handleResumeInUse();
          cancelResumeRetry();
          resumeConflict = true;
          resumeRetryAttempt = RESUME_RETRY_DELAYS.length;
          scheduleResumeRetry();
        });
        await page.waitForFunction(
          () => document.querySelector('.screen.active')?.id === 'nameScreen',
          [],
          2000
        );
        const conflict = await page.evaluate(() => ({
          button: document.getElementById('enterLobbyBtn').textContent,
          token: sessionStorage.getItem('wb_resume_token'),
          error: document.getElementById('nameError').textContent
        }));
        assert.equal(conflict.button, 'PLAY AS NEW PLAYER');
        assert.equal(conflict.token, 'ui-test-resume-token', 'the old token is kept until an explicit choice');
        assert.match(conflict.error, /another tab/i);

        await page.evaluate(() => {
          document.getElementById('playerNameInput').value = 'Tester';
        });
        await page.click('#enterLobbyBtn');
        const emittedEvents = await emitted(page);
        assert.equal(emittedEvents.filter(item => item.event === 'setName').length, 1,
          'explicit name entry must create a new session');
        assert.equal(await page.evaluate(() => sessionStorage.getItem('wb_resume_token')), null,
          'choosing a new player must drop the conflicting token');
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    const eightPlayers = Array.from({ length: 8 }, (_, index) => `Player${index + 1}`);
    for (const viewport of VIEWPORTS) {
      await test(`viewport ${viewport.name}: 8-player HUD fits, keyboard is stationary, no page scroll`, async () => {
        const page = await openGame(browser, server.origin, {
          width: viewport.width,
          height: viewport.height,
          deadlineMs: 6000,
          playerNames: eightPlayers,
          submittedOpponents: 7
        });
        try {
          const before = await controlGeometry(page);
          assert.equal(before.htmlOverflow, 'hidden');
          assert.equal(before.bodyOverflow, 'hidden');
          assert.equal(before.gamePosition, 'fixed');
          assert.ok(before.docScrollHeight <= before.innerHeight + 1, `document scroll height ${before.docScrollHeight} > ${before.innerHeight}`);
          assert.ok(before.docScrollWidth <= before.innerWidth + 1, `document scroll width ${before.docScrollWidth} > ${before.innerWidth}`);
          assert.deepEqual(before.clipped, [], `clipped controls: ${JSON.stringify(before.clipped)}`);
          assert.deepEqual(before.outsideSafeArea, [], `controls outside safe-area content box: ${JSON.stringify(before.outsideSafeArea)}`);
          assert.deepEqual(before.covered, [], `controls covered at their center: ${JSON.stringify(before.covered)}`);
          assert.ok(before.feedbackRect.height > 0, 'feedback must be visible');
          await page.screenshot(path.join(SCREENSHOTS, `game-8players-${viewport.name}.png`));

          // A long validation message must be clipped to its fixed-height line,
          // never push the keyboard.
          await page.evaluate(() => {
            setWordFeedback('A deliberately long validation message that must not move the on-screen keyboard', 'error');
          });
          await page.waitForTimeout(80);
          const afterFeedback = await controlGeometry(page);
          assertSameKeyboardRect(before, afterFeedback, 'feedback text change');
          assert.deepEqual(afterFeedback.clipped, [], `clipped controls after feedback: ${JSON.stringify(afterFeedback.clipped)}`);

          await page.waitForFunction(() => document.getElementById('gameScreen').classList.contains('screen-critical'));
          const afterTimer = await controlGeometry(page);
          assertSameKeyboardRect(before, afterTimer, 'critical timer');
          assert.deepEqual(afterTimer.clipped, [], `clipped controls during critical timer: ${JSON.stringify(afterTimer.clipped)}`);

          await page.evaluate(() => {
            window.scrollTo(0, 9999);
            document.documentElement.scrollTop = 9999;
            document.body.scrollTop = 9999;
          });
          await page.waitForTimeout(50);
          const afterScroll = await controlGeometry(page);
          assert.equal(afterScroll.scrollY, 0, 'game viewport must not scroll vertically');
          assert.equal(afterScroll.scrollX, 0, 'game viewport must not scroll horizontally');
          assert.deepEqual(afterScroll.clipped, [], `clipped controls after scroll attempt: ${JSON.stringify(afterScroll.clipped)}`);

          assert.deepEqual(page.pageErrors, []);
        } finally {
          await page.close();
        }
      });
    }

    await test('viewport 2-player HUD fits and keeps the keyboard stationary', async () => {
      const page = await openGame(browser, server.origin, {
        width: 320,
        height: 568,
        playerNames: ['Tester', 'Opponent'],
        submittedOpponents: 1
      });
      try {
        const before = await controlGeometry(page);
        assert.deepEqual(before.clipped, []);
        assert.deepEqual(before.outsideSafeArea, []);
        assert.deepEqual(before.covered, []);
        await page.waitForFunction(() => document.getElementById('gameScreen').classList.contains('screen-critical'));
        const after = await controlGeometry(page);
        assertSameKeyboardRect(before, after, '2-player critical timer');
        assert.deepEqual(after.clipped, []);
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('lobby/help/results retain normal document scrolling', async () => {
      const lobbyPage = await browser.newPage({
        width: 320,
        height: 480,
        origin: server.origin
      });
      try {
        await lobbyPage.goto(server.origin + '/');
        await lobbyPage.waitForFunction(() => window.__socket && document.getElementById('howToPlayBtn'));
        await lobbyPage.click('#howToPlayBtn');
        await lobbyPage.waitForTimeout(150);
        const help = await lobbyPage.evaluate(() => {
          const content = document.querySelector('#tutorialModal .modal-content');
          return {
            htmlOverflow: getComputedStyle(document.documentElement).overflowY,
            bodyOverflow: getComputedStyle(document.body).overflowY,
            modalScrollable: content.scrollHeight > content.clientHeight,
            active: document.getElementById('tutorialModal').classList.contains('active')
          };
        });
        assert.equal(help.active, true);
        assert.notEqual(help.htmlOverflow, 'hidden');
        assert.notEqual(help.bodyOverflow, 'hidden');
        assert.equal(help.modalScrollable, true);
      } finally {
        await lobbyPage.close();
      }

      const gamePage = await openGame(browser, server.origin);
      try {
        await gamePage.evaluate(() => showScreen('resultScreen'));
        await gamePage.waitForTimeout(900);
        const result = await gamePage.evaluate(() => ({
          gameActive: document.getElementById('gameScreen').classList.contains('active'),
          gameDisplay: getComputedStyle(document.getElementById('gameScreen')).display,
          gamePosition: getComputedStyle(document.getElementById('gameScreen')).position,
          htmlOverflow: getComputedStyle(document.documentElement).overflowY,
          bodyOverflow: getComputedStyle(document.body).overflowY
        }));
        assert.equal(result.gameActive, false);
        assert.equal(result.gameDisplay, 'none');
        assert.notEqual(result.gamePosition, 'fixed');
        assert.notEqual(result.htmlOverflow, 'hidden');
        assert.notEqual(result.bodyOverflow, 'hidden');
        assert.deepEqual(gamePage.pageErrors, []);
      } finally {
        await gamePage.close();
      }
    });

    await test('viewport-fit and safe-area insets are applied without clipping controls', async () => {
      const portrait = await browser.newPage({
        width: 390,
        height: 844,
        origin: server.origin,
        safeArea: { top: 47, right: 0, bottom: 34, left: 0 }
      });
      try {
        await portrait.goto(server.origin + '/');
        await portrait.waitForFunction(() => window.__socket && document.getElementById('wordDisplay'));
        const meta = await portrait.evaluate(() => document.querySelector('meta[name="viewport"]').content);
        assert.match(meta, /viewport-fit=cover/);
        await firePlayingState(portrait, {
          deadlineMs: 10000,
          playerNames: Array.from({ length: 8 }, (_, index) => `Player${index + 1}`),
          submittedOpponents: 7
        });
        await portrait.waitForTimeout(1000);
        const portraitState = await portrait.evaluate(() => {
          const game = document.getElementById('gameScreen');
          const style = getComputedStyle(game);
          return {
            paddingTop: parseFloat(style.paddingTop),
            paddingBottom: parseFloat(style.paddingBottom),
            height: game.getBoundingClientRect().height,
            innerHeight,
            active: game.classList.contains('active')
          };
        });
        assert.equal(portraitState.active, true);
        assert.ok(portraitState.paddingTop >= 47, `top safe area not applied: ${portraitState.paddingTop}`);
        assert.ok(portraitState.paddingBottom >= 34, `bottom safe area not applied: ${portraitState.paddingBottom}`);
        assert.ok(portraitState.height <= portraitState.innerHeight + 1);
        const portraitKeyboardTop = await portrait.evaluate(() => document.querySelector('.game-keyboard').getBoundingClientRect().top);
        const portraitGeometry = await controlGeometry(portrait);
        assert.ok(Math.abs(portraitGeometry.keyboardTop - portraitKeyboardTop) <= 0.75,
          `portrait safe-area keyboard moved: ${portraitKeyboardTop} -> ${portraitGeometry.keyboardTop}`);
        assert.deepEqual(portraitGeometry.clipped, [], `portrait safe-area clipped: ${JSON.stringify(portraitGeometry.clipped)}`);
        assert.deepEqual(portraitGeometry.outsideSafeArea, [],
          `portrait controls outside safe-area content: ${JSON.stringify(portraitGeometry.outsideSafeArea)}`);
        assert.deepEqual(portraitGeometry.covered, [], `portrait controls covered: ${JSON.stringify(portraitGeometry.covered)}`);
        assert.deepEqual(portrait.pageErrors, []);
      } finally {
        await portrait.close();
      }

      const landscape = await browser.newPage({
        width: 568,
        height: 320,
        origin: server.origin,
        safeArea: { top: 0, right: 44, bottom: 21, left: 44 }
      });
      try {
        await landscape.goto(server.origin + '/');
        await landscape.waitForFunction(() => window.__socket && document.getElementById('wordDisplay'));
        await firePlayingState(landscape, {
          deadlineMs: 10000,
          playerNames: Array.from({ length: 8 }, (_, index) => `Player${index + 1}`),
          submittedOpponents: 7
        });
        await landscape.waitForTimeout(1000);
        const landscapeState = await landscape.evaluate(() => {
          const style = getComputedStyle(document.getElementById('gameScreen'));
          return {
            paddingLeft: parseFloat(style.paddingLeft),
            paddingRight: parseFloat(style.paddingRight),
            paddingBottom: parseFloat(style.paddingBottom)
          };
        });
        assert.ok(landscapeState.paddingLeft >= 44, `left safe area not applied: ${landscapeState.paddingLeft}`);
        assert.ok(landscapeState.paddingRight >= 44, `right safe area not applied: ${landscapeState.paddingRight}`);
        assert.ok(landscapeState.paddingBottom >= 21, `bottom safe area not applied: ${landscapeState.paddingBottom}`);
        const landscapeKeyboardTop = await landscape.evaluate(() => document.querySelector('.game-keyboard').getBoundingClientRect().top);
        const landscapeGeometry = await controlGeometry(landscape);
        assert.ok(Math.abs(landscapeGeometry.keyboardTop - landscapeKeyboardTop) <= 0.75,
          `landscape safe-area keyboard moved: ${landscapeKeyboardTop} -> ${landscapeGeometry.keyboardTop}`);
        assert.deepEqual(landscapeGeometry.clipped, [], `landscape safe-area clipped: ${JSON.stringify(landscapeGeometry.clipped)}`);
        assert.deepEqual(landscapeGeometry.outsideSafeArea, [],
          `landscape controls outside safe-area content: ${JSON.stringify(landscapeGeometry.outsideSafeArea)}`);
        assert.deepEqual(landscapeGeometry.covered, [], `landscape controls covered: ${JSON.stringify(landscapeGeometry.covered)}`);
        assert.deepEqual(landscape.pageErrors, []);
      } finally {
        await landscape.close();
      }
    });

    const disconnectScenarios = [
      { name: 'comfort-portrait-320x568', width: 320, height: 568, safeArea: null },
      {
        name: 'comfort-portrait-320x568-notched',
        width: 320,
        height: 568,
        safeArea: { top: 47, right: 0, bottom: 34, left: 0 }
      },
      { name: 'comfort-landscape-568x320', width: 568, height: 320, safeArea: null },
      {
        name: 'comfort-landscape-568x320-notched',
        width: 568,
        height: 320,
        safeArea: { top: 0, right: 44, bottom: 21, left: 44 }
      }
    ];
    const disconnectedNames = Array.from(
      { length: 7 },
      (_, index) => `Player${index + 2}`.padEnd(20, 'X')
    );
    const fullRoster = ['Tester', ...disconnectedNames];

    for (const scenario of disconnectScenarios) {
      await test(`disconnect notice stays off tiles/keys and keyboard is stationary (${scenario.name})`, async () => {
        const page = await openGame(browser, server.origin, {
          width: scenario.width,
          height: scenario.height,
          comfort: true,
          safeArea: scenario.safeArea,
          playerNames: fullRoster
        });
        try {
          assert.equal(scenario.safeArea !== null, scenario.name.includes('notched'));
          assert.ok(disconnectedNames.every(name => name.length === 20));

          const keyboardTopBefore = await page.evaluate(
            () => document.querySelector('.game-keyboard').getBoundingClientRect().top
          );
          await page.evaluate((names) => {
            for (let index = 0; index < names.length; index += 1) {
              window.__socket.fire('opponentDisconnected', {
                playerId: `p${index + 2}`,
                playerName: names[index]
              });
            }
          }, disconnectedNames);
          await page.waitForTimeout(300);

          const state = await page.evaluate((names) => {
            const banner = document.getElementById('gameDisconnectNotice') ||
              document.getElementById('disconnectBanner');
            const game = document.getElementById('gameScreen');
            const style = getComputedStyle(game);
            if (!banner) return { missing: true };

            const box = element => {
              const r = element.getBoundingClientRect();
              return {
                top: r.top,
                right: r.right,
                bottom: r.bottom,
                left: r.left,
                width: r.width,
                height: r.height
              };
            };
            const intersects = (a, b) => !(
              a.right <= b.left || a.left >= b.right ||
              a.bottom <= b.top || a.top >= b.bottom
            );
            const bannerBox = box(banner);
            const controls = [
              ...document.querySelectorAll('#gameKeyboard .word-key'),
              document.getElementById('submitWordBtn'),
              ...document.querySelectorAll('#gameReactions .reaction-btn'),
              document.getElementById('wordDisplay'),
              document.getElementById('tile1'),
              document.getElementById('tile2')
            ].map(element => ({
              label: element.id || element.dataset.key || element.getAttribute('aria-label') || element.textContent.trim(),
              box: box(element),
              element
            }));

            const overlaps = controls
              .filter(control => intersects(control.box, bannerBox))
              .map(control => control.label);
            const sampledCovered = controls
              .filter(control => {
                const { box: r } = control;
                const hit = document.elementFromPoint(
                  r.left + r.width / 2,
                  r.top + r.height / 2
                );
                return !!hit && (hit === banner || banner.contains(hit) || !!hit.closest('#gameDisconnectNotice, #disconnectBanner'));
              })
              .map(control => control.label);

            const summary = banner.querySelector('.game-disconnect-summary');
            return {
              missing: false,
              role: banner.getAttribute('role'),
              position: getComputedStyle(banner).position,
              bannerBox,
              bannerText: banner.textContent,
              summary: summary ? summary.textContent.trim() : null,
              allDisconnectedNamesPresent: names.every(name => banner.textContent.includes(name)),
              overlaps,
              sampledCovered,
              keyboardTop: document.querySelector('.game-keyboard').getBoundingClientRect().top,
              paddingTop: parseFloat(style.paddingTop),
              paddingLeft: parseFloat(style.paddingLeft),
              paddingRight: parseFloat(style.paddingRight)
            };
          }, disconnectedNames);

          await page.screenshot(path.join(SCREENSHOTS, `disconnect-notice-${scenario.name}.png`));

          assert.equal(state.missing, false, 'disconnect notice was not rendered');
          assert.deepEqual(state.overlaps, [], `notice overlaps controls: ${JSON.stringify(state.overlaps)}`);
          assert.deepEqual(state.sampledCovered, [], `notice visually covers controls: ${JSON.stringify(state.sampledCovered)}`);
          assert.ok(
            Math.abs(state.keyboardTop - keyboardTopBefore) <= 0.75,
            `keyboard moved when disconnect notice appeared: ${keyboardTopBefore} -> ${state.keyboardTop}`
          );
          assert.equal(state.position, 'static', 'game notice must live in the HUD, not the global fixed overlay');
          assert.equal(state.role, 'alert');
          assert.equal(state.summary, '7 players disconnected. Waiting to reconnect.');
          assert.equal(state.allDisconnectedNamesPresent, true, 'full disconnected names must remain accessible');
          assert.ok(state.bannerBox.height <= 40, `game notice must stay compact, got ${state.bannerBox.height}px`);

          const safeArea = scenario.safeArea;
          if (safeArea) {
            assert.ok(state.bannerBox.top >= safeArea.top - 0.5, 'notice must respect top safe area');
            assert.ok(state.bannerBox.left >= safeArea.left - 0.5, 'notice must respect left safe area');
            assert.ok(state.bannerBox.right <= scenario.width - safeArea.right + 0.5, 'notice must respect right safe area');
          }
          const geometry = await controlGeometry(page);
          assert.deepEqual(geometry.clipped, [], `controls clipped after notice: ${JSON.stringify(geometry.clipped)}`);
          assert.deepEqual(page.pageErrors, []);
        } finally {
          await page.close();
        }
      });
    }

    await test('conflict button copy fits on a safe-area phone without layout overflow', async () => {
      const page = await browser.newPage({
        width: 320,
        height: 568,
        origin: server.origin,
        safeArea: { top: 47, right: 0, bottom: 34, left: 0 }
      });
      try {
        await page.goto(server.origin + '/');
        await page.waitForFunction(() => window.__socket && document.getElementById('enterLobbyBtn'));
        const state = await page.evaluate(() => {
          setEnterButtonLabel(true);
          const button = document.getElementById('enterLobbyBtn');
          const rect = button.getBoundingClientRect();
          const container = getComputedStyle(document.querySelector('.container'));
          return {
            label: button.textContent,
            ariaLabel: button.getAttribute('aria-label'),
            fitsText: button.scrollWidth <= button.clientWidth + 1,
            insideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
            horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
            paddingTop: parseFloat(container.paddingTop),
            paddingBottom: parseFloat(container.paddingBottom)
          };
        });
        assert.equal(state.label, 'PLAY AS NEW PLAYER');
        assert.equal(state.ariaLabel, 'PLAY AS NEW PLAYER');
        assert.equal(state.fitsText, true);
        assert.equal(state.insideViewport, true);
        assert.equal(state.horizontalOverflow, false);
        assert.ok(state.paddingTop >= 47);
        assert.ok(state.paddingBottom >= 34);
        await page.focus('#enterLobbyBtn');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'enterLobbyBtn');
        await page.screenshot(path.join(SCREENSHOTS, 'name-conflict-safearea-320x568.png'));
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

    await test('browser harness blocks external requests and records no page exceptions', async () => {
      const page = await openGame(browser, server.origin);
      try {
        assert.equal(page.blockedExternal.length > 0, true, 'expected the external font request to be blocked');
        assert.equal(
          page.blockedExternal.every(url => !url.startsWith(server.origin)),
          true,
          `local URL was blocked: ${JSON.stringify(page.blockedExternal)}`
        );
        assert.equal(
          page.requestedUrls.every(url => url.startsWith(server.origin) || page.blockedExternal.includes(url)),
          true
        );
        assert.deepEqual(page.pageErrors, []);
      } finally {
        await page.close();
      }
    });

  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter(result => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('Failures:');
    for (const failure of failed) console.log(`- ${failure.name}: ${failure.error.message}`);
    process.exitCode = 1;
  } else {
    console.log(`Screenshots: ${SCREENSHOTS}`);
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
