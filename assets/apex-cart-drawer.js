// APEX cart drawer: quantity and remove inside the drawer, and Add to cart on APEX product cards
// opening the drawer instead of going to the cart page.
const SECTION = 'cart-drawer-section';

const drawer = () => document.getElementById('cart-drawer');

/** Swap in the freshly rendered drawer and update the header cart count. */
function renderDrawer(html, itemCount) {
  const fresh = new DOMParser().parseFromString(html, 'text/html').querySelector('.cart-drawer__inner');
  const current = drawer()?.querySelector('.cart-drawer__inner');
  if (fresh && current) {
    current.innerHTML = fresh.innerHTML;
    current.classList.toggle('cart-drawer--empty', itemCount === 0);
  }
  const icon = /** @type {any} */ (document.querySelector('cart-icon'));
  if (icon && typeof icon.renderCartBubble === 'function') icon.renderCartBubble(itemCount, false);
}

async function changeLine(line, quantity) {
  const box = drawer()?.querySelector('[data-apex-drawer]');
  box?.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(`${window.Shopify?.routes?.root || '/'}cart/change.js`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ line, quantity, sections: SECTION, sections_url: window.location.pathname }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.description || data.message || 'Something went wrong.');
    renderDrawer(data.sections?.[SECTION] || '', data.item_count ?? 0);
  } catch (error) {
    const message = drawer()?.querySelector('[data-drawer-error]');
    if (message) {
      message.textContent = error instanceof Error ? error.message : String(error);
      message.hidden = false;
    }
    box?.removeAttribute('aria-busy');
  }
}

document.addEventListener('click', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  const inDrawer = target.closest('#cart-drawer [data-apex-drawer]');
  if (!inDrawer) return;
  if (target.closest('[data-drawer-close]')) {
    /** @type {any} */ (drawer())?.close?.();
    return;
  }
  const lineEl = /** @type {HTMLElement | null} */ (target.closest('[data-line]'));
  if (!lineEl) return;
  const line = Number(lineEl.dataset.line);

  const step = /** @type {HTMLElement | null} */ (target.closest('[data-drawer-step]'));
  if (step) {
    const current = Number(lineEl.querySelector('.apex-drawer__qty-value')?.textContent || 0);
    changeLine(line, Math.max(0, current + Number(step.dataset.drawerStep)));
    return;
  }
  if (target.closest('[data-drawer-remove]')) {
    event.preventDefault();
    changeLine(line, 0);
  }
});

// Add to cart on APEX product cards: add in place, then open the drawer
document.addEventListener('submit', async (event) => {
  const form = /** @type {HTMLFormElement} */ (event.target);
  if (!(form instanceof HTMLFormElement)) return;
  if (!form.closest('.apex-product-card, [data-apex-drawer-add]') || !form.action.includes('/cart/add')) return;
  const theDrawer = /** @type {any} */ (drawer());
  if (!theDrawer || typeof theDrawer.open !== 'function') return; // no drawer: normal cart page add

  event.preventDefault();
  const button = form.querySelector('[type="submit"]');
  button?.setAttribute('aria-busy', 'true');
  try {
    const body = new FormData(form);
    body.append('sections', SECTION);
    body.append('sections_url', window.location.pathname);
    const response = await fetch(`${window.Shopify?.routes?.root || '/'}cart/add.js`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.description || data.message || 'Could not add to cart.');
    const cart = await (await fetch(`${window.Shopify?.routes?.root || '/'}cart.js`)).json();
    renderDrawer(data.sections?.[SECTION] || '', cart.item_count ?? 0);
    theDrawer.open();
  } catch (error) {
    // Fall back to the normal form post (goes to the cart page)
    form.submit();
  } finally {
    button?.removeAttribute('aria-busy');
  }
});

// Phones: swipe the drawer to the right to close it
let swipe = null;
document.addEventListener(
  'touchstart',
  (event) => {
    const panel = /** @type {HTMLElement | null} */ (
      /** @type {HTMLElement} */ (event.target).closest?.('#cart-drawer .theme-drawer__dialog')
    );
    if (!panel || event.touches.length !== 1) return;
    swipe = { panel, x: event.touches[0].clientX, y: event.touches[0].clientY, dx: 0, active: false };
  },
  { passive: true }
);
document.addEventListener(
  'touchmove',
  (event) => {
    if (!swipe) return;
    const dx = event.touches[0].clientX - swipe.x;
    const dy = event.touches[0].clientY - swipe.y;
    // Only a mostly sideways drag to the right counts (vertical scrolling stays normal)
    if (!swipe.active && (Math.abs(dy) > Math.abs(dx) || dx < 10)) {
      if (Math.abs(dy) > 10) swipe = null;
      return;
    }
    swipe.active = true;
    swipe.dx = Math.max(0, dx);
    swipe.panel.style.transition = 'none';
    swipe.panel.style.translate = `${swipe.dx}px 0`;
  },
  { passive: true }
);
document.addEventListener('touchend', () => {
  if (!swipe) return;
  const { panel, dx, active } = swipe;
  swipe = null;
  if (!active) return;
  panel.style.transition = 'translate 0.2s ease';
  if (dx > panel.offsetWidth * 0.25) {
    panel.style.translate = '100% 0';
    setTimeout(() => {
      /** @type {any} */ (drawer())?.close?.();
      panel.style.transition = '';
      panel.style.translate = '';
    }, 200);
  } else {
    panel.style.translate = '';
  }
});

// For other APEX scripts (wishlist "Add all", account "Reorder"): after adding to the cart with
// /cart/add.js, refresh the drawer and open it. Returns false when there is no drawer.
/** @type {any} */ (window).ApexCartDrawer = {
  async refreshAndOpen() {
    const theDrawer = /** @type {any} */ (drawer());
    if (!theDrawer || typeof theDrawer.open !== 'function') return false;
    const root = window.Shopify?.routes?.root || '/';
    const [sections, cart] = await Promise.all([
      fetch(`${window.location.pathname}?sections=${SECTION}`).then((r) => r.json()),
      fetch(`${root}cart.js`).then((r) => r.json()),
    ]);
    renderDrawer(sections?.[SECTION] || '', cart.item_count ?? 0);
    theDrawer.open();
    return true;
  },
};
