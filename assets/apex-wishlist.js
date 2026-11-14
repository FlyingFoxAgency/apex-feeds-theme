// APEX wishlist.
// Saved products live in this browser (localStorage), so hearts work for everyone, signed in or
// not, with no app. Each entry is a product handle plus the variant chosen when it was saved.
// Later the list can sync to the customer's account through the APEX Cloudflare service.
//
// - <apex-wishlist-button data-handle="..." [data-variant="..."]>: the heart on product cards and
//   the product page. On the product page it saves the variant picked in the form.
// - <apex-wishlist-list>: the Wishlist view on the my-account page. Each item is rendered by
//   Shopify with the product's alternate template (product.apex-wishlist-item), so prices,
//   stock and images are always current.
(() => {
  if (window.ApexWishlist) return;

  const KEY = 'apex:wishlist';
  const EVENT = 'apex:wishlist-change';
  const root = () => window.Shopify?.routes?.root || '/';

  function read() {
    try {
      const list = JSON.parse(window.localStorage.getItem(KEY) || '[]');
      return Array.isArray(list) ? list.filter((item) => item && typeof item.h === 'string') : [];
    } catch (e) {
      return [];
    }
  }

  function write(list) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(list));
    } catch (e) {
      /* storage blocked (private mode): the heart still toggles for this page view */
    }
    memory = list;
    document.dispatchEvent(new CustomEvent(EVENT, { detail: { items: list } }));
  }

  let memory = read();

  const ApexWishlist = {
    items: () => memory.slice(),
    has: (handle) => memory.some((item) => item.h === handle),
    add(handle, variant) {
      const rest = memory.filter((item) => item.h !== handle);
      write([{ h: handle, v: variant ? Number(variant) : null, t: Date.now() }, ...rest]);
    },
    remove(handle) {
      write(memory.filter((item) => item.h !== handle));
    },
    toggle(handle, variant) {
      if (this.has(handle)) this.remove(handle);
      else this.add(handle, variant);
      return this.has(handle);
    },
  };
  window.ApexWishlist = ApexWishlist;

  // Another tab changed the list
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY) return;
    memory = read();
    document.dispatchEvent(new CustomEvent(EVENT, { detail: { items: memory } }));
  });

  class ApexWishlistButton extends HTMLElement {
    connectedCallback() {
      this.button = this.querySelector('button');
      if (!this.button) return;
      this.sync = this.sync.bind(this);
      this.button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const saved = ApexWishlist.toggle(this.dataset.handle, this.currentVariant());
        this.button.classList.remove('is-popping');
        if (saved) {
          void this.button.offsetWidth;
          this.button.classList.add('is-popping');
        }
      });
      document.addEventListener(EVENT, this.sync);
      this.sync();
    }

    disconnectedCallback() {
      document.removeEventListener(EVENT, this.sync);
    }

    currentVariant() {
      if (this.dataset.variantFromForm != null) {
        const input = document.querySelector('product-form-component form [name="id"], form[data-type="add-to-cart-form"] [name="id"]');
        if (input && input.value) return input.value;
        const fromUrl = new URLSearchParams(window.location.search).get('variant');
        if (fromUrl) return fromUrl;
      }
      return this.dataset.variant || null;
    }

    sync() {
      const saved = ApexWishlist.has(this.dataset.handle);
      this.button.setAttribute('aria-pressed', String(saved));
      const name = this.dataset.title || 'this product';
      this.button.setAttribute('aria-label', saved ? `Remove ${name} from wishlist` : `Save ${name} to wishlist`);
    }
  }

  class ApexWishlistList extends HTMLElement {
    connectedCallback() {
      this.grid = this.querySelector('[data-wishlist-grid]');
      this.count = this.querySelector('[data-wishlist-count]');
      this.empty = this.querySelector('[data-wishlist-empty]');
      this.addAll = this.querySelector('[data-wishlist-add-all]');
      this.status = this.querySelector('[data-wishlist-status]');
      this.cache = new Map();
      this.render = this.render.bind(this);
      document.addEventListener(EVENT, this.render);
      this.addEventListener('click', (event) => {
        const remove = event.target.closest('[data-wishlist-remove]');
        if (remove) {
          event.preventDefault();
          ApexWishlist.remove(remove.dataset.wishlistRemove);
        }
      });
      this.addAll?.addEventListener('click', () => this.addAllToCart());
      this.render();
    }

    disconnectedCallback() {
      document.removeEventListener(EVENT, this.render);
    }

    async fetchItem(item) {
      const key = `${item.h}:${item.v || ''}`;
      if (!this.cache.has(key)) {
        const params = new URLSearchParams({ view: 'apex-wishlist-item' });
        if (item.v) params.set('variant', String(item.v));
        const promise = fetch(`${root()}products/${encodeURIComponent(item.h)}?${params}`)
          .then((res) => (res.status === 404 ? null : res.ok ? res.text() : ''))
          .catch(() => '');
        this.cache.set(key, promise);
      }
      return this.cache.get(key);
    }

    async render() {
      const items = ApexWishlist.items();
      if (this.count) this.count.textContent = String(items.length);
      this.empty.hidden = items.length > 0;
      this.grid.hidden = items.length === 0;
      if (this.addAll) this.addAll.hidden = items.length === 0;
      const html = await Promise.all(items.map((item) => this.fetchItem(item)));
      // A product that no longer exists comes back empty: drop it from the list
      const gone = items.filter((item, i) => html[i] === null);
      if (gone.length) {
        gone.forEach((item) => this.cache.delete(`${item.h}:${item.v || ''}`));
        write(ApexWishlist.items().filter((item) => !gone.some((g) => g.h === item.h)));
        return;
      }
      this.grid.innerHTML = html.filter(Boolean).join('');
    }

    async addAllToCart() {
      const ids = [...this.grid.querySelectorAll('[data-wishlist-variant]')].map((el) => ({
        id: Number(el.dataset.wishlistVariant),
        quantity: 1,
      }));
      if (!ids.length) {
        if (this.status) this.status.textContent = 'None of your saved items can be added right now.';
        return;
      }
      this.addAll.setAttribute('aria-busy', 'true');
      try {
        const res = await fetch(`${root()}cart/add.js`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ items: ids }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.description || data.message || 'Some items could not be added.');
        }
        const opened = await window.ApexCartDrawer?.refreshAndOpen?.().catch(() => false);
        if (!opened) window.location.href = `${root()}cart`;
      } catch (error) {
        if (this.status) this.status.textContent = error.message;
      } finally {
        this.addAll.removeAttribute('aria-busy');
      }
    }
  }

  customElements.define('apex-wishlist-button', ApexWishlistButton);
  customElements.define('apex-wishlist-list', ApexWishlistList);
})();
