/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type OneKeyWindowsVaultError =
    | "busy"
    | "cancelled"
    | "failure"
    | "invalid_input"
    | "timeout"
    | "unavailable"
    | "unsupported";

export type OneKeyWindowsVaultResult =
    | { ok: true; value: Buffer; }
    | { error: OneKeyWindowsVaultError; ok: false; };

const POWERSHELL_TIMEOUT_MS = 150_000;
const STATUS_ERRORS: Record<number, OneKeyWindowsVaultError> = {
    1: "unavailable",
    2: "busy",
    3: "cancelled",
    4: "unsupported",
    5: "failure",
    6: "timeout",
};

const ONEKEY_WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$protocol = [byte[]]@(5)
$profileInput = $null
try {
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class OneKeyWindowsTransport
{
    private const byte StatusUnavailable = 1;
    private const byte StatusBusy = 2;
    private const byte StatusCancelled = 3;
    private const byte StatusUnsupported = 4;
    private const byte StatusFailure = 5;
    private const byte StatusTimeout = 6;

    private const byte InPipe = 0x81;
    private const byte OutPipe = 0x01;
    private const int PacketBytes = 64;
    private const int MaxPayloadBytes = 4096;
    private static readonly Guid InterfaceGuid = new Guid("0263b512-88cb-4136-9613-5c8e109d8ef5");
    private static readonly byte[] Empty = new byte[0];

    [StructLayout(LayoutKind.Sequential)]
    private struct SP_DEVICE_INTERFACE_DATA
    {
        public uint cbSize;
        public Guid InterfaceClassGuid;
        public uint Flags;
        public UIntPtr Reserved;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct USB_INTERFACE_DESCRIPTOR
    {
        public byte bLength;
        public byte bDescriptorType;
        public byte bInterfaceNumber;
        public byte bAlternateSetting;
        public byte bNumEndpoints;
        public byte bInterfaceClass;
        public byte bInterfaceSubClass;
        public byte bInterfaceProtocol;
        public byte iInterface;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WINUSB_PIPE_INFORMATION
    {
        public int PipeType;
        public byte PipeId;
        public ushort MaximumPacketSize;
        public byte Interval;
    }

    private sealed class TransportException : Exception
    {
        internal readonly byte Status;

        internal TransportException(byte status)
        {
            Status = status;
        }
    }

    private sealed class Message
    {
        internal readonly ushort Type;
        internal readonly byte[] Payload;

        internal Message(ushort type, byte[] payload)
        {
            Type = type;
            Payload = payload;
        }
    }

    private sealed class Field
    {
        internal int Number;
        internal int Wire;
        internal uint NumberValue;
        internal byte[] BytesValue;
    }

    [DllImport("setupapi.dll", EntryPoint = "SetupDiGetClassDevsW", SetLastError = true)]
    private static extern IntPtr SetupDiGetClassDevs(
        ref Guid classGuid,
        IntPtr enumerator,
        IntPtr parent,
        uint flags);

    [DllImport("setupapi.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetupDiEnumDeviceInterfaces(
        IntPtr deviceInfoSet,
        IntPtr deviceInfoData,
        ref Guid interfaceClassGuid,
        uint memberIndex,
        ref SP_DEVICE_INTERFACE_DATA interfaceData);

    [DllImport("setupapi.dll", EntryPoint = "SetupDiGetDeviceInterfaceDetailW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetupDiGetDeviceInterfaceDetail(
        IntPtr deviceInfoSet,
        ref SP_DEVICE_INTERFACE_DATA interfaceData,
        IntPtr detailData,
        uint detailDataSize,
        out uint requiredSize,
        IntPtr deviceInfoData);

    [DllImport("setupapi.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetupDiDestroyDeviceInfoList(IntPtr deviceInfoSet);

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("winusb.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WinUsb_Initialize(SafeFileHandle deviceHandle, out IntPtr interfaceHandle);

    [DllImport("winusb.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WinUsb_Free(IntPtr interfaceHandle);

    [DllImport("winusb.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WinUsb_QueryInterfaceSettings(
        IntPtr interfaceHandle,
        byte alternateSetting,
        out USB_INTERFACE_DESCRIPTOR descriptor);

    [DllImport("winusb.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WinUsb_QueryPipe(
        IntPtr interfaceHandle,
        byte alternateSetting,
        byte pipeIndex,
        out WINUSB_PIPE_INFORMATION pipeInformation);

    [DllImport("winusb.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WinUsb_SetPipePolicy(
        IntPtr interfaceHandle,
        byte pipeId,
        uint policyType,
        uint valueLength,
        ref uint value);

    [DllImport("winusb.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WinUsb_ResetPipe(IntPtr interfaceHandle, byte pipeId);

    [DllImport("winusb.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WinUsb_FlushPipe(IntPtr interfaceHandle, byte pipeId);

    [DllImport("winusb.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WinUsb_WritePipe(
        IntPtr interfaceHandle,
        byte pipeId,
        byte[] buffer,
        uint bufferLength,
        out uint lengthTransferred,
        IntPtr overlapped);

    [DllImport("winusb.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WinUsb_ReadPipe(
        IntPtr interfaceHandle,
        byte pipeId,
        byte[] buffer,
        uint bufferLength,
        out uint lengthTransferred,
        IntPtr overlapped);

    public static byte[] Run(byte[] profileInput)
    {
        try
        {
            if (profileInput == null || profileInput.Length != 32)
                throw new TransportException(StatusUnsupported);

            byte[] secret = RunOnDevice(profileInput);
            try
            {
                byte[] result = new byte[33];
                result[0] = 0;
                Buffer.BlockCopy(secret, 0, result, 1, secret.Length);
                return result;
            }
            finally
            {
                Array.Clear(secret, 0, secret.Length);
            }
        }
        catch (TransportException error)
        {
            return new byte[] { error.Status };
        }
        catch
        {
            return new byte[] { StatusFailure };
        }
        finally
        {
            if (profileInput != null)
                Array.Clear(profileInput, 0, profileInput.Length);
        }
    }

    private static byte[] RunOnDevice(byte[] profileInput)
    {
        List<string> paths = FindDevicePaths();
        if (paths.Count == 0)
            throw new TransportException(StatusUnavailable);

        bool sawBusy = false;
        for (int index = 0; index < paths.Count; index++)
        {
            SafeFileHandle deviceHandle = CreateFile(
                paths[index],
                0xC0000000,
                0x00000003,
                IntPtr.Zero,
                3,
                0x40000080,
                IntPtr.Zero);
            if (deviceHandle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                deviceHandle.Dispose();
                if (IsBusy(error)) sawBusy = true;
                continue;
            }

            using (deviceHandle)
            {
                IntPtr interfaceHandle;
                if (!WinUsb_Initialize(deviceHandle, out interfaceHandle))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (IsBusy(error)) sawBusy = true;
                    continue;
                }

                try
                {
                    ValidateInterface(interfaceHandle);
                    return RunProtocol(interfaceHandle, profileInput);
                }
                finally
                {
                    WinUsb_Free(interfaceHandle);
                }
            }
        }

        throw new TransportException(sawBusy ? StatusBusy : StatusUnavailable);
    }

    private static List<string> FindDevicePaths()
    {
        const uint PresentDeviceInterface = 0x12;
        Guid interfaceGuid = InterfaceGuid;
        IntPtr deviceInfoSet = SetupDiGetClassDevs(
            ref interfaceGuid,
            IntPtr.Zero,
            IntPtr.Zero,
            PresentDeviceInterface);
        if (deviceInfoSet == new IntPtr(-1))
            ThrowNative();

        List<string> paths = new List<string>();
        try
        {
            for (uint index = 0; index < 64; index++)
            {
                SP_DEVICE_INTERFACE_DATA interfaceData = new SP_DEVICE_INTERFACE_DATA();
                interfaceData.cbSize = (uint)Marshal.SizeOf(typeof(SP_DEVICE_INTERFACE_DATA));
                if (!SetupDiEnumDeviceInterfaces(
                    deviceInfoSet,
                    IntPtr.Zero,
                    ref interfaceGuid,
                    index,
                    ref interfaceData))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 259) break;
                    ThrowNative(error);
                }

                uint requiredSize;
                SetupDiGetDeviceInterfaceDetail(
                    deviceInfoSet,
                    ref interfaceData,
                    IntPtr.Zero,
                    0,
                    out requiredSize,
                    IntPtr.Zero);
                if (requiredSize < 8 || requiredSize > 32768)
                    throw new TransportException(StatusFailure);

                IntPtr detailData = Marshal.AllocHGlobal((int)requiredSize);
                try
                {
                    Marshal.WriteInt32(detailData, IntPtr.Size == 8 ? 8 : 6);
                    if (!SetupDiGetDeviceInterfaceDetail(
                        deviceInfoSet,
                        ref interfaceData,
                        detailData,
                        requiredSize,
                        out requiredSize,
                        IntPtr.Zero))
                        ThrowNative();

                    string path = Marshal.PtrToStringUni(IntPtr.Add(detailData, 4));
                    if (IsExactOneKeyPath(path)) paths.Add(path);
                }
                finally
                {
                    Marshal.FreeHGlobal(detailData);
                }
            }
        }
        finally
        {
            SetupDiDestroyDeviceInfoList(deviceInfoSet);
        }
        return paths;
    }

    private static bool IsExactOneKeyPath(string path)
    {
        if (String.IsNullOrEmpty(path)) return false;
        return path.IndexOf("vid_1209", StringComparison.OrdinalIgnoreCase) >= 0 &&
            (path.IndexOf("pid_53c1", StringComparison.OrdinalIgnoreCase) >= 0 ||
                path.IndexOf("pid_4f4b", StringComparison.OrdinalIgnoreCase) >= 0) &&
            path.IndexOf("mi_00", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private static void ValidateInterface(IntPtr interfaceHandle)
    {
        USB_INTERFACE_DESCRIPTOR descriptor;
        if (!WinUsb_QueryInterfaceSettings(interfaceHandle, 0, out descriptor))
            ThrowNative();
        if (descriptor.bInterfaceNumber != 0 || descriptor.bAlternateSetting != 0 ||
            descriptor.bInterfaceClass != 0xff || descriptor.bNumEndpoints < 2)
            throw new TransportException(StatusUnsupported);

        bool foundIn = false;
        bool foundOut = false;
        for (byte index = 0; index < descriptor.bNumEndpoints; index++)
        {
            WINUSB_PIPE_INFORMATION pipe;
            if (!WinUsb_QueryPipe(interfaceHandle, 0, index, out pipe))
                ThrowNative();
            if (pipe.PipeId == InPipe && pipe.MaximumPacketSize == PacketBytes) foundIn = true;
            if (pipe.PipeId == OutPipe && pipe.MaximumPacketSize == PacketBytes) foundOut = true;
        }
        if (!foundIn || !foundOut)
            throw new TransportException(StatusUnsupported);

        uint inputTimeout = 120000;
        uint outputTimeout = 10000;
        if (!WinUsb_SetPipePolicy(interfaceHandle, InPipe, 3, 4, ref inputTimeout) ||
            !WinUsb_SetPipePolicy(interfaceHandle, OutPipe, 3, 4, ref outputTimeout))
            ThrowNative();
        WinUsb_ResetPipe(interfaceHandle, InPipe);
        WinUsb_ResetPipe(interfaceHandle, OutPipe);
        WinUsb_FlushPipe(interfaceHandle, InPipe);
    }

    private static byte[] RunProtocol(IntPtr interfaceHandle, byte[] profileInput)
    {
        Send(interfaceHandle, 0, Empty);
        Message features = Receive(interfaceHandle);
        try
        {
            if (features.Type == 3) ThrowFailure(features.Payload);
            if (features.Type != 17) throw new TransportException(StatusUnsupported);
            ValidateFeatures(features.Payload);
        }
        finally
        {
            Array.Clear(features.Payload, 0, features.Payload.Length);
        }

        byte[] request = BuildCipherRequest(profileInput);
        try
        {
            Send(interfaceHandle, 23, request);
        }
        finally
        {
            Array.Clear(request, 0, request.Length);
        }

        for (int interaction = 0; interaction < 12; interaction++)
        {
            Message response = Receive(interfaceHandle);
            try
            {
                if (response.Type == 3) ThrowFailure(response.Payload);
                if (response.Type == 18)
                {
                    Send(interfaceHandle, 10000, Empty);
                    continue;
                }
                if (response.Type == 26)
                {
                    Send(interfaceHandle, 27, Empty);
                    continue;
                }
                if (response.Type == 41)
                {
                    Send(interfaceHandle, 42, new byte[] { 0x18, 0x01 });
                    continue;
                }
                if (response.Type != 48)
                    throw new TransportException(StatusUnsupported);
                return ReadCipherValue(response.Payload);
            }
            finally
            {
                Array.Clear(response.Payload, 0, response.Payload.Length);
            }
        }
        throw new TransportException(StatusFailure);
    }

    private static byte[] BuildCipherRequest(byte[] profileInput)
    {
        using (MemoryStream stream = new MemoryStream())
        {
            WriteUnsignedField(stream, 1, 0x80002720);
            WriteUnsignedField(stream, 1, 0);
            WriteBytesField(stream, 2, System.Text.Encoding.UTF8.GetBytes("ProtonnCord Secure Messaging"));
            WriteBytesField(stream, 3, profileInput);
            WriteUnsignedField(stream, 4, 1);
            WriteUnsignedField(stream, 5, 1);
            WriteUnsignedField(stream, 6, 1);
            if (stream.Length > MaxPayloadBytes)
                throw new TransportException(StatusUnsupported);
            return stream.ToArray();
        }
    }

    private static void ValidateFeatures(byte[] payload)
    {
        List<Field> fields = ParseFields(payload);
        try
        {
            uint bootloader;
            bool hasBootloader = TryGetNumber(fields, 5, out bootloader);
            uint pinProtected;
            uint initialized;
            uint deviceType;
            if ((hasBootloader && bootloader == 1) ||
                !TryGetNumber(fields, 7, out pinProtected) || pinProtected != 1 ||
                !TryGetNumber(fields, 12, out initialized) || initialized != 1 ||
                !TryGetNumber(fields, 600, out deviceType) || deviceType != 1 ||
                !HasCapability(fields, 5))
                throw new TransportException(StatusUnsupported);
        }
        finally
        {
            ClearFields(fields);
        }
    }

    private static bool TryGetNumber(List<Field> fields, int number, out uint value)
    {
        for (int index = 0; index < fields.Count; index++)
        {
            if (fields[index].Number == number && fields[index].Wire == 0)
            {
                value = fields[index].NumberValue;
                return true;
            }
        }
        value = 0;
        return false;
    }

    private static bool HasCapability(List<Field> fields, uint capability)
    {
        for (int index = 0; index < fields.Count; index++)
        {
            Field field = fields[index];
            if (field.Number != 30) continue;
            if (field.Wire == 0 && field.NumberValue == capability) return true;
            if (field.Wire != 2) continue;
            int offset = 0;
            while (offset < field.BytesValue.Length)
            {
                uint value = ReadVarint(field.BytesValue, ref offset);
                if (value == capability) return true;
            }
        }
        return false;
    }

    private static void ThrowFailure(byte[] payload)
    {
        List<Field> fields = ParseFields(payload);
        try
        {
            uint code;
            if (TryGetNumber(fields, 1, out code) && (code == 4 || code == 6))
                throw new TransportException(StatusCancelled);
            throw new TransportException(StatusFailure);
        }
        finally
        {
            ClearFields(fields);
        }
    }

    private static byte[] ReadCipherValue(byte[] payload)
    {
        List<Field> fields = ParseFields(payload);
        byte[] value = null;
        try
        {
            for (int index = 0; index < fields.Count; index++)
            {
                Field field = fields[index];
                if (field.Number != 1 || field.Wire != 2) continue;
                if (value != null || field.BytesValue.Length != 32)
                    throw new TransportException(StatusFailure);
                value = new byte[32];
                Buffer.BlockCopy(field.BytesValue, 0, value, 0, value.Length);
            }
            if (value == null)
                throw new TransportException(StatusFailure);
            bool nonzero = false;
            for (int index = 0; index < value.Length; index++)
                nonzero |= value[index] != 0;
            if (!nonzero)
            {
                Array.Clear(value, 0, value.Length);
                throw new TransportException(StatusFailure);
            }
            return value;
        }
        catch
        {
            if (value != null) Array.Clear(value, 0, value.Length);
            throw;
        }
        finally
        {
            ClearFields(fields);
        }
    }

    private static List<Field> ParseFields(byte[] payload)
    {
        List<Field> fields = new List<Field>();
        int offset = 0;
        try
        {
            while (offset < payload.Length)
            {
                uint tag = ReadVarint(payload, ref offset);
                int number = (int)(tag >> 3);
                int wire = (int)(tag & 7);
                if (number < 1) throw new TransportException(StatusUnsupported);
                Field field = new Field();
                field.Number = number;
                field.Wire = wire;
                if (wire == 0)
                {
                    field.NumberValue = ReadVarint(payload, ref offset);
                }
                else if (wire == 2)
                {
                    uint length = ReadVarint(payload, ref offset);
                    if (length > MaxPayloadBytes || length > payload.Length - offset)
                        throw new TransportException(StatusUnsupported);
                    field.BytesValue = new byte[length];
                    Buffer.BlockCopy(payload, offset, field.BytesValue, 0, (int)length);
                    offset += (int)length;
                }
                else
                {
                    throw new TransportException(StatusUnsupported);
                }
                fields.Add(field);
            }
            return fields;
        }
        catch
        {
            ClearFields(fields);
            throw;
        }
    }

    private static void ClearFields(List<Field> fields)
    {
        for (int index = 0; index < fields.Count; index++)
        {
            byte[] value = fields[index].BytesValue;
            if (value != null) Array.Clear(value, 0, value.Length);
        }
    }

    private static uint ReadVarint(byte[] data, ref int offset)
    {
        uint result = 0;
        for (int count = 0; count < 5 && offset < data.Length; count++)
        {
            byte item = data[offset++];
            if (count == 4 && (item & 0xf0) != 0)
                throw new TransportException(StatusUnsupported);
            result |= (uint)(item & 0x7f) << (count * 7);
            if ((item & 0x80) == 0) return result;
        }
        throw new TransportException(StatusUnsupported);
    }

    private static void WriteUnsignedField(Stream stream, uint number, uint value)
    {
        WriteVarint(stream, number << 3);
        WriteVarint(stream, value);
    }

    private static void WriteBytesField(Stream stream, uint number, byte[] value)
    {
        WriteVarint(stream, (number << 3) | 2);
        WriteVarint(stream, (uint)value.Length);
        stream.Write(value, 0, value.Length);
    }

    private static void WriteVarint(Stream stream, uint value)
    {
        do
        {
            byte item = (byte)(value & 0x7f);
            value >>= 7;
            stream.WriteByte((byte)(item | (value == 0 ? 0 : 0x80)));
        }
        while (value != 0);
    }

    private static void Send(IntPtr interfaceHandle, ushort messageType, byte[] payload)
    {
        if (payload == null || payload.Length > MaxPayloadBytes)
            throw new TransportException(StatusUnsupported);
        int offset = 0;
        bool first = true;
        do
        {
            byte[] packet = new byte[PacketBytes];
            try
            {
                packet[0] = 0x3f;
                int payloadOffset = first ? 9 : 1;
                if (first)
                {
                    packet[1] = 0x23;
                    packet[2] = 0x23;
                    packet[3] = (byte)(messageType >> 8);
                    packet[4] = (byte)messageType;
                    packet[5] = (byte)(payload.Length >> 24);
                    packet[6] = (byte)(payload.Length >> 16);
                    packet[7] = (byte)(payload.Length >> 8);
                    packet[8] = (byte)payload.Length;
                }
                int count = Math.Min(PacketBytes - payloadOffset, payload.Length - offset);
                if (count > 0) Buffer.BlockCopy(payload, offset, packet, payloadOffset, count);
                offset += count;
                uint transferred;
                if (!WinUsb_WritePipe(interfaceHandle, OutPipe, packet, PacketBytes, out transferred, IntPtr.Zero))
                    ThrowNative();
                if (transferred != PacketBytes)
                    throw new TransportException(StatusFailure);
            }
            finally
            {
                Array.Clear(packet, 0, packet.Length);
            }
            first = false;
        }
        while (offset < payload.Length);
    }

    private static Message Receive(IntPtr interfaceHandle)
    {
        byte[] first = ReadPacket(interfaceHandle);
        try
        {
            if (first[0] != 0x3f || first[1] != 0x23 || first[2] != 0x23)
                throw new TransportException(StatusUnsupported);
            ushort type = (ushort)((first[3] << 8) | first[4]);
            uint length = ((uint)first[5] << 24) | ((uint)first[6] << 16) |
                ((uint)first[7] << 8) | first[8];
            if (length > MaxPayloadBytes)
                throw new TransportException(StatusUnsupported);

            byte[] payload = new byte[length];
            try
            {
                int offset = Math.Min((int)length, 55);
                if (offset > 0) Buffer.BlockCopy(first, 9, payload, 0, offset);
                while (offset < length)
                {
                    byte[] continuation = ReadPacket(interfaceHandle);
                    try
                    {
                        if (continuation[0] != 0x3f)
                            throw new TransportException(StatusUnsupported);
                        int count = Math.Min(63, (int)length - offset);
                        Buffer.BlockCopy(continuation, 1, payload, offset, count);
                        offset += count;
                    }
                    finally
                    {
                        Array.Clear(continuation, 0, continuation.Length);
                    }
                }
                return new Message(type, payload);
            }
            catch
            {
                Array.Clear(payload, 0, payload.Length);
                throw;
            }
        }
        finally
        {
            Array.Clear(first, 0, first.Length);
        }
    }

    private static byte[] ReadPacket(IntPtr interfaceHandle)
    {
        byte[] packet = new byte[PacketBytes];
        uint transferred;
        if (!WinUsb_ReadPipe(interfaceHandle, InPipe, packet, PacketBytes, out transferred, IntPtr.Zero))
        {
            Array.Clear(packet, 0, packet.Length);
            ThrowNative();
        }
        if (transferred != PacketBytes)
        {
            Array.Clear(packet, 0, packet.Length);
            throw new TransportException(StatusFailure);
        }
        return packet;
    }

    private static bool IsBusy(int error)
    {
        return error == 5 || error == 32 || error == 170;
    }

    private static void ThrowNative()
    {
        ThrowNative(Marshal.GetLastWin32Error());
    }

    private static void ThrowNative(int error)
    {
        if (IsBusy(error)) throw new TransportException(StatusBusy);
        if (error == 2 || error == 3 || error == 1167)
            throw new TransportException(StatusUnavailable);
        if (error == 121) throw new TransportException(StatusTimeout);
        if (error == 995) throw new TransportException(StatusCancelled);
        throw new TransportException(StatusFailure);
    }
}
'@ | Out-Null

    $encodedInput = [Console]::In.ReadLine()
    if ($null -eq $encodedInput -or $encodedInput -notmatch '^[A-Za-z0-9_-]{43}$') {
        $protocol = [byte[]]@(4)
    } else {
        $profileInput = [Convert]::FromBase64String(
            $encodedInput.Replace('-', '+').Replace('_', '/').PadRight(44, '='))
        $encodedInput = $null
        if ($profileInput.Length -ne 32) {
            $protocol = [byte[]]@(4)
        } else {
            $protocol = [OneKeyWindowsTransport]::Run($profileInput)
        }
    }
} catch {
    $protocol = [byte[]]@(5)
} finally {
    if ($null -ne $profileInput) {
        [Array]::Clear($profileInput, 0, $profileInput.Length)
    }
}

$stdout = [Console]::OpenStandardOutput()
try {
    $stdout.Write($protocol, 0, $protocol.Length)
    $stdout.Flush()
} finally {
    [Array]::Clear($protocol, 0, $protocol.Length)
    $stdout.Dispose()
}
`;

function runPowerShell(scriptPath: string, profileInput: string): Promise<Buffer> {
    const systemRoot = process.env.SystemRoot ?? String.raw`C:\Windows`;
    const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return new Promise((resolve, reject) => {
        const child = execFile(
            powershell,
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
            {
                encoding: null,
                maxBuffer: 1_024,
                shell: false,
                timeout: POWERSHELL_TIMEOUT_MS,
                windowsHide: true,
            },
            (error, stdout, stderr) => {
                const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
                if (error) {
                    output.fill(0);
                    if (Buffer.isBuffer(stderr)) stderr.fill(0);
                    reject(error);
                    return;
                }
                resolve(output);
            },
        );
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(`${profileInput}\r\n`, "ascii");
    });
}

export async function runOneKeyWindowsVaultCipher(profileInput: string): Promise<OneKeyWindowsVaultResult> {
    if (process.platform !== "win32") return { error: "unsupported", ok: false };
    if (!/^[A-Za-z0-9_-]{43}$/u.test(profileInput)) return { error: "invalid_input", ok: false };
    const decoded = Buffer.from(profileInput, "base64url");
    const valid = decoded.byteLength === 32 && decoded.toString("base64url") === profileInput;
    decoded.fill(0);
    if (!valid) return { error: "invalid_input", ok: false };

    let temporaryDirectory: string | null = null;
    let scriptPath: string | null = null;
    try {
        temporaryDirectory = await mkdtemp(join(tmpdir(), "protonncord-onekey-"));
        scriptPath = join(temporaryDirectory, "onekey-winusb.ps1");
        await writeFile(scriptPath, ONEKEY_WINDOWS_SCRIPT, { encoding: "utf8", flag: "wx", mode: 0o600 });
        let output: Buffer;
        try {
            output = await runPowerShell(scriptPath, profileInput);
        } catch (error) {
            const childError = error as NodeJS.ErrnoException & { killed?: boolean; };
            return {
                error: childError.killed || childError.code === "ETIMEDOUT" ? "timeout" : "failure",
                ok: false,
            };
        }

        try {
            if (output.byteLength === 33 && output[0] === 0) {
                const value = Buffer.from(output.subarray(1));
                if (value.every(byte => byte === 0)) {
                    value.fill(0);
                    return { error: "failure", ok: false };
                }
                return { ok: true, value };
            }
            if (output.byteLength === 1 && STATUS_ERRORS[output[0]])
                return { error: STATUS_ERRORS[output[0]], ok: false };
            return { error: "failure", ok: false };
        } finally {
            output.fill(0);
        }
    } catch {
        return { error: "failure", ok: false };
    } finally {
        if (scriptPath) await unlink(scriptPath).catch(() => undefined);
        if (temporaryDirectory) await rm(temporaryDirectory).catch(() => undefined);
    }
}
