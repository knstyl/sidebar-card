import { expect } from '@wdio/globals';
import { browser } from '@wdio/globals';

describe('SidebarCard Component', () => {
    let sidebarCard: any;
    let mockHass: any;

    beforeEach(async () => {
        // Create mock Home Assistant object
        mockHass = {
            language: 'en',
            states: {
                'weather.home': {
                    state: 'sunny',
                    attributes: {
                        temperature: 22,
                        unit_of_measurement: '°C',
                        friendly_name: 'Home Weather'
                    }
                },
                'switch.living_room_light': {
                    state: 'on'
                },
                'switch.bedroom_light': {
                    state: 'off'
                }
            },
            callService: () => Promise.resolve()
        };

        // Execute in browser context to create the component
        await browser.execute(() => {
            // Import and register the component if not already done
            if (!customElements.get('sidebar-card')) {
                // This would typically be imported from your component file
                // For now, we'll assume it's already loaded
            }
            
            // Create the sidebar-card element
            const sidebarCard = document.createElement('sidebar-card');
            sidebarCard.hass = arguments[0]; // Pass mockHass
            sidebarCard.id = 'test-sidebar-card';
            
            // Append to document body so it can be tested
            document.body.appendChild(sidebarCard);
            
            return true;
        }, mockHass);
    });

    afterEach(async () => {
        // Clean up after each test
        await browser.execute(() => {
            const testCard = document.getElementById('test-sidebar-card');
            if (testCard && testCard.parentNode) {
                testCard.parentNode.removeChild(testCard);
            }
        });
    });

    describe('Weather Widget', () => {
        it('should render weather widget when configured', async () => {
            const config = {
                weather: true,
                weatherEntity: 'weather.home',
                weatherFormat: 'temperature_unit'
            };

            const hasWeatherWidget = await browser.execute((cfg) => {
                const sidebarCard = document.getElementById('test-sidebar-card') as any;
                sidebarCard.setConfig(cfg);
                // Wait for update
                return new Promise((resolve) => {
                    setTimeout(() => {
                        const weatherWidget = sidebarCard.shadowRoot.querySelector('.weather-widget');
                        resolve(!!weatherWidget);
                    }, 100);
                });
            }, config);

            expect(hasWeatherWidget).toBe(true);
        });

        it('should display correct temperature and unit', async () => {
            const config = {
                weather: true,
                weatherEntity: 'weather.home',
                weatherFormat: 'temperature_unit'
            };

            const temperatureText = await browser.execute((cfg) => {
                const sidebarCard = document.getElementById('test-sidebar-card') as any;
                sidebarCard.setConfig(cfg);
                
                return new Promise((resolve) => {
                    setTimeout(() => {
                        sidebarCard._runWeather();
                        const weatherTemp = sidebarCard.shadowRoot.querySelector('.weather-temp');
                        resolve(weatherTemp ? weatherTemp.textContent : null);
                    }, 100);
                });
            }, config);

            expect(temperatureText).toBe('22°C');
        });

        it('should display correct weather condition', async () => {
            const config = {
                weather: true,
                weatherEntity: 'weather.home'
            };

            const conditionText = await browser.execute((cfg) => {
                const sidebarCard = document.getElementById('test-sidebar-card') as any;
                sidebarCard.setConfig(cfg);
                
                return new Promise((resolve) => {
                    setTimeout(() => {
                        sidebarCard._runWeather();
                        const weatherDesc = sidebarCard.shadowRoot.querySelector('.weather-desc');
                        resolve(weatherDesc ? weatherDesc.textContent : null);
                    }, 100);
                });
            }, config);

            expect(conditionText).toBe('Sunny');
        });

        it('should handle different weather states', async () => {
            const testCases = [
                { state: 'cloudy', expected: 'Cloudy' },
                { state: 'rainy', expected: 'Rainy' },
                { state: 'snowy', expected: 'Snowy' },
                { state: 'fog', expected: 'Fog' }
            ];

            for (const testCase of testCases) {
                const conditionText = await browser.execute((state, expected) => {
                    const sidebarCard = document.getElementById('test-sidebar-card') as any;
                    // Update mock hass state
                    sidebarCard.hass.states['weather.home'].state = state;
                    
                    const config = {
                        weather: true,
                        weatherEntity: 'weather.home'
                    };
                    
                    sidebarCard.setConfig(config);
                    
                    return new Promise((resolve) => {
                        setTimeout(() => {
                            sidebarCard._runWeather();
                            const weatherDesc = sidebarCard.shadowRoot.querySelector('.weather-desc');
                            resolve(weatherDesc ? weatherDesc.textContent : null);
                        }, 100);
                    });
                }, testCase.state, testCase.expected);

                expect(conditionText).toBe(testCase.expected);
            }
        });

        it('should not render weather widget when weather is disabled', async () => {
            const config = {
                weather: false,
                weatherEntity: 'weather.home'
            };

            const hasWeatherWidget = await browser.execute((cfg) => {
                const sidebarCard = document.getElementById('test-sidebar-card') as any;
                sidebarCard.setConfig(cfg);
                
                return new Promise((resolve) => {
                    setTimeout(() => {
                        const weatherWidget = sidebarCard.shadowRoot.querySelector('.weather-widget');
                        resolve(!!weatherWidget);
                    }, 100);
                });
            }, config);

            expect(hasWeatherWidget).toBe(false);
        });
    });

    describe('Digital Clock Widget', () => {
        it('should render digital clock when configured', async () => {
            const config = {
                digitalClock: true
            };

            const hasDigitalClock = await browser.execute((cfg) => {
                const sidebarCard = document.getElementById('test-sidebar-card') as any;
                sidebarCard.setConfig(cfg);
                
                return new Promise((resolve) => {
                    setTimeout(() => {
                        const digitalClock = sidebarCard.shadowRoot.querySelector('.digitalClock');
                        resolve(!!digitalClock);
                    }, 100);
                });
            }, config);

            expect(hasDigitalClock).toBe(true);
        });

        it('should display time in 24-hour format by default', async () => {
            const config = {
                digitalClock: true,
                twelveHourVersion: false
            };

            const timeText = await browser.execute((cfg) => {
                const sidebarCard = document.getElementById('test-sidebar-card') as any;
                sidebarCard.setConfig(cfg);
                
                // Mock Date to return 14:30
                const originalDate = Date;
                global.Date = class extends Date {
                    constructor() {
                        super();
                        return new originalDate('2023-01-01T14:30:00');
                    }
                    static now() {
                        return new originalDate('2023-01-01T14:30:00').getTime();
                    }
                } as any;
                
                return new Promise((resolve) => {
                    setTimeout(() => {
                        sidebarCard._runClock();
                        const digitalClock = sidebarCard.shadowRoot.querySelector('.digitalClock');
                        global.Date = originalDate; // Restore original Date
                        resolve(digitalClock ? digitalClock.textContent : null);
                    }, 100);
                });
            }, config);

            expect(timeText).toMatch(/^\d{2}:\d{2}$/); // Should match HH:MM format
        });
    });

    describe('Sidebar Menu', () => {
        it('should render menu items when configured', async () => {
            const config = {
                sidebarMenu: [
                    {
                        name: 'Living Room',
                        icon: 'mdi:lightbulb',
                        action: 'toggle',
                        entity: 'switch.living_room_light'
                    },
                    {
                        name: 'Bedroom',
                        icon: 'mdi:lightbulb',
                        action: 'toggle',
                        entity: 'switch.bedroom_light'
                    }
                ]
            };

            const menuData = await browser.execute((cfg) => {
                const sidebarCard = document.getElementById('test-sidebar-card') as any;
                sidebarCard.setConfig(cfg);
                
                return new Promise((resolve) => {
                    setTimeout(() => {
                        const menuItems = sidebarCard.shadowRoot.querySelectorAll('.sidebarMenu li');
                        const menuInfo = Array.from(menuItems).map((item: any) => ({
                            text: item.textContent?.trim(),
                            length: menuItems.length
                        }));
                        resolve(menuInfo);
                    }, 100);
                });
            }, config);

            expect(menuData).toHaveLength(2);
            expect(menuData[0].text).toContain('Living Room');
            expect(menuData[1].text).toContain('Bedroom');
        });

        it('should mark active menu items based on entity state', async () => {
            const config = {
                sidebarMenu: [
                    {
                        name: 'Living Room',
                        action: 'toggle',
                        entity: 'switch.living_room_light',
                        state: 'switch.living_room_light'
                    },
                    {
                        name: 'Bedroom',
                        action: 'toggle',
                        entity: 'switch.bedroom_light',
                        state: 'switch.bedroom_light'
                    }
                ]
            };

            const activeStates = await browser.execute((cfg) => {
                const sidebarCard = document.getElementById('test-sidebar-card') as any;
                sidebarCard.setConfig(cfg);
                
                return new Promise((resolve) => {
                    setTimeout(() => {
                        const menuItems = sidebarCard.shadowRoot.querySelectorAll('.sidebarMenu li');
                        const states = Array.from(menuItems).map((item: any) => 
                            item.classList.contains('active')
                        );
                        resolve(states);
                    }, 100);
                });
            }, config);

            // Living room light is 'on', so should be active
            expect(activeStates[0]).toBe(true);
            // Bedroom light is 'off', so should not be active
            expect(activeStates[1]).toBe(false);
        });

        it('should have correct data attributes for toggle action', async () => {
            const config = {
                sidebarMenu: [
                    {
                        name: 'Living Room',
                        action: 'toggle',
                        entity: 'switch.living_room_light'
                    }
                ]
            };

            const dataType = await browser.execute((cfg) => {
                const sidebarCard = document.getElementById('test-sidebar-card') as any;
                sidebarCard.setConfig(cfg);
                
                return new Promise((resolve) => {
                    setTimeout(() => {
                        const menuItem = sidebarCard.shadowRoot.querySelector('.sidebarMenu li');
                        resolve(menuItem ? menuItem.getAttribute('data-type') : null);
                    }, 100);
                });
            }, config);

            expect(dataType).toBe('toggle');
        });
    });

    describe('Date Widget', () => {
        it('should render date when configured', async () => {
            const config = {
                date: true,
                dateFormat: 'DD MMMM'
            };

            const hasDateElement = await browser.execute((cfg) => {
                const sidebarCard = document.getElementById('test-sidebar-card') as any;
                sidebarCard.setConfig(cfg);
                
                return new Promise((resolve) => {
                    setTimeout(() => {
                        const dateElement = sidebarCard.shadowRoot.querySelector('.date');
                        resolve(!!dateElement);
                    }, 100);
                });
            }, config);

            expect(hasDateElement).toBe(true);
        });
    });

    describe('Title', () => {
        it('should render title when configured', async () => {
            const config = {
                title: 'My Smart Home'
            };

            const titleData = await browser.execute((cfg) => {
                const sidebarCard = document.getElementById('test-sidebar-card') as any;
                sidebarCard.setConfig(cfg);
                
                return new Promise((resolve) => {
                    setTimeout(() => {
                        const titleElement = sidebarCard.shadowRoot.querySelector('.title');
                        resolve({
                            exists: !!titleElement,
                            text: titleElement ? titleElement.textContent : null
                        });
                    }, 100);
                });
            }, config);

            expect(titleData.exists).toBe(true);
            expect(titleData.text).toBe('My Smart Home');
        });

        it('should not render title when not configured', async () => {
            const config = {};

            const hasTitleElement = await browser.execute((cfg) => {
                const sidebarCard = document.getElementById('test-sidebar-card') as any;
                sidebarCard.setConfig(cfg);
                
                return new Promise((resolve) => {
                    setTimeout(() => {
                        const titleElement = sidebarCard.shadowRoot.querySelector('.title');
                        resolve(!!titleElement);
                    }, 100);
                });
            }, config);

            expect(hasTitleElement).toBe(false);
        });
    });
});