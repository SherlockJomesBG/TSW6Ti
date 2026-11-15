# Getting Started with TSW6 Telemetry

Welcome to the **TSW6 Telemetry Interface**! This dashboard provides a live stream of data directly from Train Sim World 6. 

To use the interface, you must configure the game to enable the External Interface API and locate your unique Communication API Key.

## Connection and Security

To enable the External Interface API, Train Sim World 6 must be launched with the command line parameter `-HTTPAPI`. 

This can be done within Steam:
1. Find the title in your **Steam Library**, right-click on it, and select **Properties**.
2. From the dialog that opens, select the **General** tab (which should be the default).
3. In the **LAUNCH OPTIONS** section, add the parameter: `-HTTPAPI`.

With this in place, load the game up to the main menu once and then exit. This will ensure that the communication API key is generated.

## Finding Your Comm API Key

In a “Release” build of the game vs a “Development” build of the game, the location of the generated key file will be different. Most people accessing this API will be using a Release build. If Dovetail Games have specifically advised you are on a Development build then the alternative location will apply for all profile and save data including the Comm API Key.

### Release Builds
To find the generated key, go to the following location:
> `Documents\My Games\TrainSimWorld6\Saved\Config`

Here you will find a file `CommAPIKey.txt`

### Development Builds
To find the generated key, locate the install folder for the game and navigate to a `Saved\Config` folder. For example, if your Train Sim World 6 installation in Steam is located here:
`D:\SteamLibrary\steamapps\common\TrainSimWorld6`

Then you should navigate from the above into this folder:
> `WindowsNoEditor\TS2Prototype\Saved\Config`

Here you will find the file `CommAPIKey.txt`

### About the Key
Open the file in notepad and it will contain a string. This string is the key that must be sent as part of all requests to the API or they will be rejected.

The key includes all standard ASCII characters in the file but does not include any CR/LF characters at the end.

For example, the key might look like this: `7I0HydlP4d4/66aQPrrHg43N4X5Y+6gCnRIjtIAOwA8=`

> [!NOTE]
> The Key can change at any time, and if the `CommAPIKey.txt` file is deleted a new (different) key will be created. Every time the file is created on any system, it’s generated randomly.

> [!CAUTION]
> There is never any reason to share your Comm Key with anyone. Doing so will potentially permit them access to connect to your game, and if any vulnerabilities were ever identified within TSW could enable worse things to happen. If anyone asks you for the Comm Key, you should not share it under any circumstances. If you think it might have gotten out at all, delete the file so that a new one is auto generated and restart the game.

## Connection Details

Connections to the API are made via a TCP socket connection to port `31270`.
By default, only `127.0.0.1:31270` is opened for connection, meaning the socket cannot be connected to from another computer on the network.
Note that only standard TCP is supported, not HTTPS or any other form of Secure Encrypted communication, so be sure to always use “http” and not “https” in any request URLs.
Enter just the IP Address (`127.0.0.1`) into the IP Address field (the port is filled in automatically by the system)

## Opening Network Access to Other Computers

By default, only a socket is opened on the `127.0.0.1` “local” network interface to enhance security as this inherently prevents any external connections from being possible.

For some use cases however it may be required or advantageous to have the external software running on a different PC to the PC that the game is running on. To make this work, the socket must be configured to open on all network interfaces.

To achieve this, go to the home folder for the game data, this will be in the same place as the `CommAPIKey.txt` was located.
Where the `CommAPIKey.txt` was in `Saved\Config`, you should now go one further level deep to `Saved\Config\WindowsNoEditor`.
Inside here you will find `engine.ini` which is one of the internal configuration files for the game. It’s a text file openable in your normal favourite text editor.

Within here, you need to add a new section to the INI file:

```ini
[HTTPServer.Listeners]
DefaultBindAddress=0.0.0.0
```

Specifically note the new `[HTTPServer.Listeners]` section. Setting the “DefaultBindAddress” address to `0.0.0.0` instructs the game to bind to all network interfaces.

Save the file, restart the game and you should now be able to connect to it from other computers.

> [!WARNING]
> It is important that you consider the security implications of an open socket however the API isn’t capable of much so risk is minimal. In a professional environment we would recommend use of Firewalls to ensure that only expected devices are able to access the machine on this port.