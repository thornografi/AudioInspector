// @ts-check

import RegexDetector from '../RegexDetector.js';

export const TeamsDetector = new RegexDetector('teams', 'Microsoft Teams', ['teams.microsoft.com', 'teams.live.com']);
export const DiscordDetector = new RegexDetector('discord', 'Discord', ['discord.com']);
export const ZoomDetector = new RegexDetector('zoom', 'Zoom', ['zoom.us']);
export const MeetDetector = new RegexDetector('meet', 'Google Meet', ['meet.google.com']);
export const WhatsAppDetector = new RegexDetector('whatsapp', 'WhatsApp Web', ['web.whatsapp.com']);
export const SlackDetector = new RegexDetector('slack', 'Slack', ['slack.com']);
export const MessengerDetector = new RegexDetector('messenger', 'Facebook Messenger', ['messenger.com']);
export const SkypeDetector = new RegexDetector('skype', 'Skype', ['skype.com']);

