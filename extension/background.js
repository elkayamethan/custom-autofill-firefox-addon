'use strict';
// Firefox deletes runtime-registered content scripts whenever the add-on is
// installed, updated or downgraded (they survive normal browser restarts), so
// restore the registration each time this event page starts.
syncRegistration();

// Being a persistent listener, this also keeps the event page asleep at normal
// browser startups: it only runs after install, update, downgrade or re-enable.
browser.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') browser.runtime.openOptionsPage();
});
