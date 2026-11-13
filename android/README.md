# ImotSync Android app

**Placeholder.** The companion app is planned for Week 4 of the [roadmap](../README.md#roadmap). There is no code here yet.

## What it will do

The app is for brokers in the field, at the property:

- **Log in** with the same account as the admin panel (JWT from the ImotSync API).
- **Take photos** with the phone camera.
- **Fill in a short form**: type, deal type, city, district, price, area, rooms, floor and a description.
- **Save the property as a draft.** Publishing to the portals stays in the admin panel, where the pre-publish check shows what each portal still needs.
- **Work offline.** Drafts and photos are stored on the phone and sent to the API automatically when a connection is available.

## Planned stack

| Concern         | Library                                          |
| --------------- | ------------------------------------------------ |
| Language        | Kotlin                                           |
| UI              | Jetpack Compose                                  |
| Camera          | CameraX                                          |
| Local storage   | Room (offline drafts and pending photo uploads)  |
| Networking      | Retrofit                                         |
| Background sync | WorkManager (retries until the device is online) |

## How it will be set up

The project will be generated with Android Studio directly into this `android/` folder in Week 4, using the Gradle wrapper so it builds without a local Gradle installation. Build outputs and local machine settings (`build/`, `.gradle/`, `local.properties`) are already git-ignored.

The app will talk only to the ImotSync REST API; it never contacts the real estate portals itself.
