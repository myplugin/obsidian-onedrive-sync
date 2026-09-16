# Limitations From The Browser Environment

Obsidian desktop is developed by using [Electron](https://www.electronjs.org/). And Obsidian mobile is developed by using [Capacitor](https://capacitorjs.com/)

Technically, the plugin (or any plugin?) runs in the js environment provided by Obsidian. And to support the mobile Obsidian, the plugin is limited to be developed for the browser environment, instead of the Node.js environment.

Then some limitations are applied:

1. [The CORS issue (solved in the new Obsidian version on some platforms).](./cors.md)
2. [No Node.js environment.](./no_nodejs.md)
3. If the cloud service uses OAuth flow, it needs to support PKCE. More details are [here](./oauth2_pkce.md).
4. [No background running after Obsidian is closed.](./no_background_after_closing.md)

## Related

- [OneDrive setup and OAuth flow](../remote_services/onedrive/README.md)
- [Encryption methods](../encryption/README.md)
