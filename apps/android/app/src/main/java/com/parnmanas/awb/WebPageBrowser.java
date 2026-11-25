package com.parnmanas.awb;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.net.Uri;
import android.widget.Toast;
import androidx.browser.customtabs.CustomTabsClient;
import androidx.browser.customtabs.CustomTabsIntent;
import java.util.Collections;

/** Keep the whole site, including OAuth redirects, in the browser's existing cookie store. */
final class WebPageBrowser {
  private WebPageBrowser() {}

  static void open(Activity activity, Uri uri) {
    if (ServerUrls.originOf(uri.toString()).isEmpty()) return;
    // Prefer Chrome so an installed alternate default browser does not lose Chrome's sign-in.
    String provider = CustomTabsClient.getPackageName(activity, Collections.singletonList("com.android.chrome"), true);
    if (provider == null) provider = CustomTabsClient.getPackageName(activity, null);
    CustomTabsIntent tab = new CustomTabsIntent.Builder().setShowTitle(true).build();
    tab.intent.setPackage(provider);
    try {
      // With no Custom Tabs provider, ACTION_VIEW opens the ordinary browser instead.
      tab.launchUrl(activity, uri);
    } catch (ActivityNotFoundException e) {
      Toast.makeText(activity, R.string.page_browser_missing, Toast.LENGTH_LONG).show();
    }
  }
}
