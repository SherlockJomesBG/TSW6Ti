import sqlite3 
import os

dbDir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
dbPath = os.path.join(dbDir, "tsw6ti.db")

conn = sqlite3.connect(dbPath)
cursor = conn.cursor()

print("Creating table 'Users'...")
cursor.execute('''
    CREATE TABLE IF NOT EXISTS Users (
        userID INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        passwordHash TEXT NOT NULL
    )
''')

print("Creating table 'Sessions'...")
cursor.execute('''
    CREATE TABLE IF NOT EXISTS Sessions (
        tokenHash TEXT PRIMARY KEY,
        userID INTEGER NOT NULL,
        expiresAt TEXT NOT NULL,
        FOREIGN KEY (userID) REFERENCES Users(userID)
    )
''')

print("Creating table 'Connections'...")
cursor.execute('''
    CREATE TABLE IF NOT EXISTS Connections (
        connectionID INTEGER PRIMARY KEY AUTOINCREMENT,
        userID INTEGER NOT NULL,
        ipAddress TEXT NOT NULL,
        apiKey TEXT NOT NULL,
        FOREIGN KEY (userID) REFERENCES Users(userID)
    )
''')

conn.commit()
conn.close()
print("Database 'tsw6ti.db' created successfully.")