# Limitations From The Browser Environment: OAuth2 PKCE

If the cloud service uses OAuth flow, it needs to support PKCE, because the plugin is released to the public, and no real secrets can be statically kept in the client.

Luckily, OneDrive supports PKCE, making it possible for this plugin to connect to it easily.

There is an excellent article explaining what PKCE is and how to use it.
