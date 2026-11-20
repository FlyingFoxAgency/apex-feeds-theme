// APEX My account > Subscriptions, on Appstle's customer portal API.
// Appstle answers on the store's own domain through Shopify's app proxy
// (/apps/subscriptions/cp/api/...) and knows the signed-in customer from Shopify, so no keys
// are needed. Docs: https://developers.appstle.com/subscription/build-your-own-frontend
//
// The list loads the first time the Subscriptions view opens. Before Appstle is installed the
// API isn't there, so the card shows its "no subscriptions yet" state.
//
// Appstle's field names are read defensively (several shapes are accepted), because the list
// endpoint's exact response isn't published. Check against a real subscription once installed.
(() => {
  if (customElements.get('apex-subscriptions')) return;

  const num = (value) => {
    if (value == null) return null;
    if (typeof value === 'object') value = value.amount ?? value.value;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const gidId = (value) => (value == null ? null : String(value).split('/').pop());
  const parse = (value) => {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch (e) {
      return null;
    }
  };

  /** Turn one Appstle contract into what the row needs. */
  function normalise(contract) {
    const c = contract.subscriptionContract || contract;
    const linesSource =
      c.lines?.nodes ||
      c.lines?.edges?.map((edge) => edge.node) ||
      (Array.isArray(c.lines) ? c.lines : null) ||
      parse(c.contractDetailsJSON) ||
      [];
    const lines = (Array.isArray(linesSource) ? linesSource : []).map((line) => {
      const current = num(line.currentPrice) ?? num(line.price);
      const base =
        num(line.pricingPolicy?.basePrice) ?? num(line.basePrice) ?? num(line.compareAtPrice) ?? num(line.originalPrice);
      const image = line.variantImage?.transformedSrc || line.variantImage?.url || line.variantImage || line.image?.url || line.image || '';
      return {
        title: line.title || line.productTitle || 'Subscription',
        variantTitle: line.variantTitle && line.variantTitle !== 'Default Title' ? line.variantTitle : '',
        image: typeof image === 'string' ? image : '',
        quantity: Number(line.quantity) || 1,
        current,
        base,
      };
    });
    const interval = String(c.billingPolicyInterval || c.billingPolicy?.interval || c.interval || 'MONTH').toUpperCase();
    const count = Number(c.billingPolicyIntervalCount || c.billingPolicy?.intervalCount || c.intervalCount || 1);
    return {
      id: gidId(c.subscriptionContractId ?? c.contractId ?? c.id),
      status: String(c.status || '').toUpperCase(),
      next: c.nextBillingDate || c.nextOrderDate || null,
      interval,
      count,
      lines,
    };
  }

  class ApexSubscriptions extends HTMLElement {
    connectedCallback() {
      this.api = (this.dataset.api || '/apps/subscriptions/cp/api').replace(/\/$/, '');
      this.list = this.querySelector('[data-subs-list]');
      this.template = this.querySelector('[data-subs-template]');
      this.frequencies = (this.dataset.frequencies || '1')
        .split(',')
        .map((v) => parseInt(v, 10))
        .filter((v) => v > 0);
      this.money = new Intl.NumberFormat('en-AU', { style: 'currency', currency: this.dataset.currency || 'AUD' });
      this.loaded = false;
      this.onView = (event) => {
        if (event.detail?.view === 'subscriptions') this.load();
      };
      document.addEventListener('apex:account-view', this.onView);
      if (!this.closest('[hidden]')) this.load();
    }

    disconnectedCallback() {
      document.removeEventListener('apex:account-view', this.onView);
    }

    async request(path, options = {}) {
      const res = await fetch(`${this.api}/${path}`, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        ...options,
      });
      const type = res.headers.get('content-type') || '';
      if (res.status === 404 || !type.includes('json')) {
        const error = new Error('not-connected');
        error.notConnected = true;
        throw error;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.title || data.detail || 'That didn’t work. Please try again.');
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    state(name) {
      this.querySelector('[data-subs-loading]')?.remove();
      this.querySelector('[data-subs-empty]').hidden = name !== 'empty';
      this.querySelector('[data-subs-error]').hidden = name !== 'error';
      this.querySelector('[data-subs-portal]').hidden = name !== 'list';
    }

    async load(force = false) {
      if (this.loaded && !force) return;
      this.loaded = true;
      try {
        const data = await this.request(`subscription-customers-detail/valid/${this.dataset.customerId}`);
        const contracts = (Array.isArray(data) ? data : data?.contracts || data?.subscriptionContracts || [])
          .map(normalise)
          .filter((c) => c.id && c.status !== 'CANCELLED' && c.status !== 'EXPIRED');
        this.render(contracts);
      } catch (error) {
        this.list.innerHTML = '';
        this.setCount(0);
        this.state(error.notConnected ? 'empty' : 'error');
        if (!error.notConnected) this.loaded = false;
      }
    }

    setCount(n) {
      const count = this.querySelector('[data-subs-count]');
      if (count) count.textContent = n ? ` (${n})` : '';
    }

    frequencyText(interval, count) {
      const unit = { DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' }[interval] || 'month';
      return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
    }

    dateText(value) {
      if (!value) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    render(contracts) {
      this.list.innerHTML = '';
      this.setCount(contracts.length);
      if (!contracts.length) {
        this.state('empty');
        return;
      }
      this.state('list');
      contracts.forEach((contract) => this.list.append(this.row(contract)));
    }

    row(contract) {
      const row = this.template.content.firstElementChild.cloneNode(true);
      const line = contract.lines[0] || { title: 'Subscription', quantity: 1 };
      const extra = contract.lines.length - 1;
      const paused = contract.status === 'PAUSED';
      row.dataset.contract = contract.id;

      const img = row.querySelector('[data-subs-img]');
      if (line.image) {
        img.src = line.image;
        img.alt = line.title;
        img.hidden = false;
      }
      row.querySelector('[data-subs-title]').textContent = extra > 0 ? `${line.title} + ${extra} more` : line.title;
      const status = row.querySelector('[data-subs-status]');
      status.textContent = paused ? 'Paused' : 'Active';
      status.classList.toggle('apex-account__status--dark', !paused);
      const options = [line.variantTitle.replaceAll(' / ', '  ·  '), line.quantity > 1 ? `Qty ${line.quantity}` : '']
        .filter(Boolean)
        .join('  ·  ');
      row.querySelector('[data-subs-options]').textContent = options;
      row.querySelector('[data-subs-frequency]').textContent = this.frequencyText(contract.interval, contract.count);
      const next = this.dateText(contract.next);
      row.querySelector('[data-subs-next]').textContent = paused ? 'Paused' : next ? next : 'Being scheduled';

      // Price for the whole delivery, with the full price struck through when it's discounted
      const current = contract.lines.reduce((sum, l) => sum + (l.current ?? 0) * l.quantity, 0);
      const base = contract.lines.reduce((sum, l) => sum + (l.base ?? l.current ?? 0) * l.quantity, 0);
      row.querySelector('[data-subs-price]').textContent = current ? this.money.format(current) : '';
      const save = base > current && current > 0 ? Math.round(((base - current) / base) * 100) : 0;
      row.querySelector('[data-subs-was]').textContent = save ? this.money.format(base) : '';
      row.querySelector('[data-subs-per]').textContent = save ? `per delivery, save ${save}%` : 'per delivery';

      const show = { skip: !paused, frequency: this.frequencies.length > 1, pause: !paused, resume: paused, cancel: true };
      row.querySelectorAll('[data-subs-action]').forEach((button) => {
        button.hidden = !show[button.dataset.subsAction];
        button.addEventListener('click', () => this.action(row, contract, button.dataset.subsAction));
      });
      return row;
    }

    panel(row, html) {
      const panel = row.querySelector('[data-subs-panel]');
      panel.innerHTML = html;
      panel.hidden = !html;
      panel.querySelector('[data-subs-close]')?.addEventListener('click', () => this.panel(row, ''));
      return panel;
    }

    message(row, text) {
      row.querySelector('[data-subs-message]').textContent = text || '';
    }

    action(row, contract, kind) {
      this.message(row, '');
      if (kind === 'resume') return this.run(row, () => this.setStatus(contract, 'ACTIVE'), 'Subscription resumed.');
      if (kind === 'pause') {
        const panel = this.panel(
          row,
          `<p>Pause this subscription? No deliveries go out until you resume it.</p>
           <button type="button" class="apex-button apex-account__button--moss" data-subs-confirm>Pause subscription</button>
           <button type="button" class="apex-subs__plain" data-subs-close>Keep it active</button>`
        );
        panel.querySelector('[data-subs-confirm]').addEventListener('click', () =>
          this.run(row, () => this.setStatus(contract, 'PAUSED'), 'Subscription paused.')
        );
        return;
      }
      if (kind === 'cancel') {
        const panel = this.panel(
          row,
          `<p>Cancel this subscription? You won't be charged for any more deliveries.</p>
           <button type="button" class="apex-button apex-account__button--outline" data-subs-confirm>Yes, cancel it</button>
           <button type="button" class="apex-subs__plain" data-subs-close>Keep my subscription</button>`
        );
        panel.querySelector('[data-subs-confirm]').addEventListener('click', () =>
          this.run(
            row,
            () => this.request(`subscription-contracts/${contract.id}`, { method: 'DELETE' }),
            'Subscription cancelled.'
          )
        );
        return;
      }
      if (kind === 'skip') {
        const panel = this.panel(
          row,
          `<p>Skip the next delivery${contract.next ? ` (${this.dateText(contract.next)})` : ''}? The one after goes out as usual.</p>
           <button type="button" class="apex-button apex-account__button--moss" data-subs-confirm>Skip it</button>
           <button type="button" class="apex-subs__plain" data-subs-close>Keep it</button>`
        );
        panel.querySelector('[data-subs-confirm]').addEventListener('click', () =>
          this.run(row, () => this.skipNext(contract), 'Next delivery skipped.')
        );
        return;
      }
      if (kind === 'frequency') {
        const options = this.frequencies
          .map((n) => `<option value="${n}"${n === contract.count ? ' selected' : ''}>${this.frequencyText('MONTH', n)}</option>`)
          .join('');
        const panel = this.panel(
          row,
          `<label class="visually-hidden" for="SubsFreq-${contract.id}">Delivery frequency</label>
           <select id="SubsFreq-${contract.id}" data-subs-select>${options}</select>
           <button type="button" class="apex-button apex-account__button--moss" data-subs-confirm>Save</button>
           <button type="button" class="apex-subs__plain" data-subs-close>Cancel</button>`
        );
        panel.querySelector('[data-subs-confirm]').addEventListener('click', () => {
          const count = panel.querySelector('[data-subs-select]').value;
          this.run(
            row,
            () =>
              this.request(
                `subscription-contracts-update-billing-interval?contractId=${contract.id}&interval=MONTH&intervalCount=${count}`,
                { method: 'PUT' }
              ),
            'Delivery frequency updated.'
          );
        });
      }
    }

    setStatus(contract, status) {
      return this.request(`subscription-contracts-update-status?contractId=${contract.id}&status=${status}`, { method: 'PUT' });
    }

    async skipNext(contract) {
      const orders = await this.request(`subscription-billing-attempts/top-orders?contractId=${contract.id}`);
      const list = Array.isArray(orders) ? orders : orders?.content || [];
      const next = list.find((o) => String(o.status || '').toUpperCase() === 'QUEUED') || list[0];
      if (!next) throw new Error('There’s no upcoming delivery to skip.');
      return this.request(`subscription-billing-attempts/skip-order/${next.id}?subscriptionContractId=${contract.id}`, {
        method: 'PUT',
      });
    }

    async run(row, task, done) {
      row.classList.add('is-busy');
      try {
        await task();
        await this.load(true);
        const fresh = this.list.querySelector(`[data-contract="${CSS.escape(row.dataset.contract)}"]`);
        if (fresh) this.message(fresh, done);
      } catch (error) {
        row.classList.remove('is-busy');
        this.message(row, error.notConnected ? 'Subscriptions aren’t available just now.' : error.message);
      }
    }
  }

  customElements.define('apex-subscriptions', ApexSubscriptions);
})();
